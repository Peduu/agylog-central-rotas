(function () {
  'use strict';

  const CSV_URL = 'data/latest-positions.csv';
  const REFRESH_SECONDS = 30;
  const SLIDE_DURATION_MS = 1100;
  const MIN_SLIDE_METERS = 12;
  const MAX_SLIDE_METERS = 3000;
  const STOPPED_DRIFT_METERS = 60;
  const STATUS_LIMITS_MINUTES = {
    live: 5,
    recent: 20,
    delayed: 360,
  };

  const state = {
    vehicles: [],
    selectedId: null,
    lockedVehicleId: null,
    filter: 'all',
    search: '',
    countdown: REFRESH_SECONDS,
    map: null,
    markerLayer: null,
    markers: new Map(),
    markerAnimations: new Map(),
    hasFittedInitialView: false,
  };

  const els = {
    totalCount: document.getElementById('totalCount'),
    goodCount: document.getElementById('goodCount'),
    attentionCount: document.getElementById('attentionCount'),
    fleetList: document.getElementById('fleetList'),
    detailDrawer: document.getElementById('detailDrawer'),
    searchInput: document.getElementById('searchInput'),
    fitButton: document.getElementById('fitButton'),
    sourceStatus: document.getElementById('sourceStatus'),
    refreshCountdown: document.getElementById('refreshCountdown'),
    mapTitle: document.getElementById('mapTitle'),
  };

  const statusCopy = {
    live: 'Ao vivo',
    stopped: 'Parado',
    recent: 'Recente',
    delayed: 'Atrasado',
    gps_bad: 'GPS ruim',
    old: 'Antigo',
    no_location: 'Sem local',
  };

  const ATTENTION_STATUSES = ['delayed', 'gps_bad', 'old', 'no_location'];
  const GOOD_STATUSES = ['live', 'stopped', 'recent'];

  // Paleta vibrante — cores maximamente distintas entre si
  const COLOR_PALETTE = [
    '#ff2d55', // vermelho
    '#ff9f0a', // laranja
    '#ffd60a', // amarelo
    '#30d158', // verde
    '#0a84ff', // azul
    '#bf5af2', // roxo
    '#5ac8fa', // ciano
    '#ff2d9b', // rosa quente
    '#20c997', // verde-água
    '#ff6b35', // laranja escuro
    '#a8d8ea', // azul claro
    '#c8f560', // verde lima
  ];

  const vehicleColorMap = new Map();

  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    bindEvents();
    loadPositions();
    window.setInterval(tick, 1000);
    window.setInterval(loadPositions, REFRESH_SECONDS * 1000);
    if (window.lucide) window.lucide.createIcons();
  });

  function initMap() {
    state.map = L.map('map', {
      zoomControl: false,
      preferCanvas: true,
    }).setView([-23.56, -46.63], 9);

    L.control.zoom({ position: 'bottomright' }).addTo(state.map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(state.map);

    state.markerLayer = L.layerGroup().addTo(state.map);
    state.map.on('moveend zoomend', renderFleetList);

    // Garante que o Leaflet reconheça o tamanho real do container
    window.setTimeout(() => state.map.invalidateSize(), 100);
  }

  function bindEvents() {
    els.searchInput.addEventListener('input', (event) => {
      state.search = event.target.value.trim().toLowerCase();
      render();
    });

    els.fitButton.addEventListener('click', fitAllMarkers);

    document.querySelectorAll('.tab').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
        button.classList.add('active');
        state.filter = button.dataset.filter;
        render();
      });
    });
  }

  async function loadPositions() {
    try {
      const response = await fetch(`${CSV_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      state.vehicles = parseCsv(text).map(normalizeVehicle);
      state.countdown = REFRESH_SECONDS;
      els.sourceStatus.textContent = `CSV atualizado ${formatClock(new Date())}`;
      render();
      if (!state.hasFittedInitialView) {
        fitAllMarkers(false);
        state.hasFittedInitialView = true;
      }
    } catch (error) {
      els.sourceStatus.textContent = 'Sem leitura do CSV';
      console.error(error);
    }
  }

  function tick() {
    state.countdown = Math.max(0, state.countdown - 1);
    els.refreshCountdown.textContent = `${state.countdown}s`;
    if (state.countdown === 0) els.refreshCountdown.textContent = '...';
  }

  function parseCsv(text) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const headerIndex = lines.findIndex((line) => line.startsWith('Rastreador;'));
    if (headerIndex === -1) return [];

    const headers = lines[headerIndex].split(';').map((h, i) => h || `extra_${i}`);

    return lines.slice(headerIndex + 1).map((line) => {
      const cells = line.split(';');
      return headers.reduce((row, h, i) => {
        row[h] = cells[i] || '';
        return row;
      }, {});
    });
  }

  function assignColor(id) {
    if (!vehicleColorMap.has(id)) {
      vehicleColorMap.set(id, COLOR_PALETTE[vehicleColorMap.size % COLOR_PALETTE.length]);
    }
    return vehicleColorMap.get(id);
  }

  function normalizeVehicle(row) {
    const date = parseBrazilianDate(row.Horario || row['Horário']);
    const lat = parseBrazilianNumber(row.Latitude);
    const lng = parseBrazilianNumber(row.Longitude);
    const speed = parseInt(String(row.Velocidade || '').match(/\d+/)?.[0] || '0', 10);
    const gps = row.GPS || '';
    const minutesOld = Number.isFinite(date?.getTime())
      ? Math.max(0, (Date.now() - date.getTime()) / 60000)
      : Infinity;
    const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
    const id = slug(row.Rastreador || 'sem-rastreador');
    const vehicleType = getVehicleType(row.Rastreador || '', row.Tipo || '');
    const status = getStatus({ gps, minutesOld, speed, hasLocation });
    const gpsStale = status === 'gps_bad';
    const color = assignColor(id);

    return {
      id,
      name: row.Rastreador || 'Sem identificacao',
      vehicleType,
      color,
      address: row.Endereco || row['Endereço'] || 'Sem endereco',
      lat,
      lng,
      date,
      minutesOld,
      speed,
      ignition: row.Ignicao || row['Ignição'] || '-',
      battery: row.Bateria || '-',
      signal: row.Sinal || '-',
      gps,
      gpsStale,
      status,
      hasLocation,
    };
  }

  function getVehicleType(name, tipo) {
    const haystack = removeAccents(`${name} ${tipo}`).toLowerCase();
    if (haystack.includes('bau') || haystack.includes('truck') || haystack.includes('iveco') || haystack.includes('cargo')) return 'truck';
    if (haystack.includes('master') || haystack.includes('partner') || haystack.includes('sprinter') || haystack.includes('van') || haystack.includes('hr')) return 'van';
    if (haystack.includes('moto') || haystack.includes('bike') || haystack.includes('cg') || haystack.includes('fan')) return 'bike';
    return 'car';
  }

  function getStatus({ gps, minutesOld, speed, hasLocation }) {
    if (!hasLocation) return 'no_location';
    if (gps.toLowerCase().includes('inval')) return 'gps_bad';
    if (minutesOld <= STATUS_LIMITS_MINUTES.live) return speed > 0 ? 'live' : 'stopped';
    if (minutesOld <= STATUS_LIMITS_MINUTES.recent) return 'recent';
    if (minutesOld <= STATUS_LIMITS_MINUTES.delayed) return 'delayed';
    return 'old';
  }

  function render() {
    renderMetrics();
    renderMap();
    renderFleetList();
    renderDetail();
    if (window.lucide) window.lucide.createIcons();
  }

  function renderMetrics() {
    const good = state.vehicles.filter((v) => GOOD_STATUSES.includes(v.status)).length;
    const attention = state.vehicles.filter((v) => ATTENTION_STATUSES.includes(v.status)).length;
    els.totalCount.textContent = state.vehicles.length;
    els.goodCount.textContent = good;
    els.attentionCount.textContent = attention;
  }

  function renderMap() {
    const visibleMarkerIds = new Set();

    state.vehicles
      .filter((v) => v.hasLocation)
      .forEach((vehicle) => {
        visibleMarkerIds.add(vehicle.id);
        renderVehicleMarker(vehicle);
      });

    state.markers.forEach((marker, id) => {
      if (!visibleMarkerIds.has(id)) {
        cancelMarkerSlide(id);
        state.markerLayer.removeLayer(marker);
        state.markers.delete(id);
      }
    });

    if (state.lockedVehicleId && !visibleMarkerIds.has(state.lockedVehicleId)) {
      state.lockedVehicleId = null;
    }
  }

  function renderVehicleMarker(vehicle) {
    const targetLatLng = L.latLng(vehicle.lat, vehicle.lng);
    const marker = state.markers.get(vehicle.id);

    if (!marker) {
      const newMarker = L.marker(targetLatLng, {
        icon: createVehicleIcon(vehicle),
        title: vehicle.name,
        zIndexOffset: getMarkerZIndex(vehicle),
      });

      newMarker.bindPopup(vehiclePopupHtml(vehicle));
      newMarker.on('click', () => selectVehicle(vehicle.id));
      state.markers.set(vehicle.id, newMarker);
      state.markerLayer.addLayer(newMarker);
      return;
    }

    marker.options.title = vehicle.name;
    marker.setIcon(createVehicleIcon(vehicle));
    marker.setZIndexOffset(getMarkerZIndex(vehicle));
    marker.setPopupContent(vehiclePopupHtml(vehicle));
    moveMarker(marker, vehicle, targetLatLng);
  }

  function vehiclePopupHtml(vehicle) {
    return `
      <div class="popup-title">${escapeHtml(vehicle.name)}</div>
      <div class="popup-meta">${escapeHtml(statusCopy[vehicle.status])} · ${escapeHtml(formatAge(vehicle.minutesOld))}</div>
      ${vehicle.gpsStale ? '<div class="popup-stale">⚠ Posição pode estar desatualizada</div>' : ''}
    `;
  }

  function moveMarker(marker, vehicle, targetLatLng) {
    const currentLatLng = marker.getLatLng();
    const meters = state.map.distance(currentLatLng, targetLatLng);

    if (!Number.isFinite(meters) || sameLatLng(currentLatLng, targetLatLng)) {
      cancelMarkerSlide(vehicle.id);
      centerLockedMarker(vehicle.id, currentLatLng);
      return;
    }

    if (isStopped(vehicle) && meters <= STOPPED_DRIFT_METERS) {
      cancelMarkerSlide(vehicle.id);
      centerLockedMarker(vehicle.id, currentLatLng);
      return;
    }

    if (meters < MIN_SLIDE_METERS) {
      cancelMarkerSlide(vehicle.id);
      centerLockedMarker(vehicle.id, currentLatLng);
      return;
    }

    if (!shouldSlideMarker(vehicle, meters)) {
      cancelMarkerSlide(vehicle.id);
      marker.setLatLng(targetLatLng);
      centerLockedMarker(vehicle.id, targetLatLng);
      return;
    }

    slideMarkerTo(marker, vehicle.id, targetLatLng);
  }

  function shouldSlideMarker(vehicle, meters) {
    if (vehicle.gpsStale) return false;
    if (isStopped(vehicle)) return false;
    if (vehicle.status === 'old' || vehicle.status === 'delayed') return false;
    return meters <= MAX_SLIDE_METERS;
  }

  function isStopped(vehicle) {
    return vehicle.speed <= 0 || vehicle.status === 'stopped';
  }

  function slideMarkerTo(marker, id, targetLatLng) {
    const activeAnimation = state.markerAnimations.get(id);
    if (activeAnimation && sameLatLng(activeAnimation.target, targetLatLng)) return;

    cancelMarkerSlide(id);

    const startLatLng = marker.getLatLng();
    const startTime = performance.now();
    const animation = { frame: null, target: targetLatLng };
    state.markerAnimations.set(id, animation);

    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / SLIDE_DURATION_MS);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const lat = startLatLng.lat + (targetLatLng.lat - startLatLng.lat) * easedProgress;
      const lng = startLatLng.lng + (targetLatLng.lng - startLatLng.lng) * easedProgress;

      marker.setLatLng([lat, lng]);
      centerLockedMarker(id, L.latLng(lat, lng));

      if (progress < 1) {
        animation.frame = window.requestAnimationFrame(step);
        return;
      }

      marker.setLatLng(targetLatLng);
      centerLockedMarker(id, targetLatLng);
      state.markerAnimations.delete(id);
    };

    animation.frame = window.requestAnimationFrame(step);
  }

  function cancelMarkerSlide(id) {
    const activeAnimation = state.markerAnimations.get(id);
    if (activeAnimation?.frame) {
      window.cancelAnimationFrame(activeAnimation.frame);
    }
    state.markerAnimations.delete(id);
  }

  function sameLatLng(a, b) {
    return Math.abs(a.lat - b.lat) < 0.000001 && Math.abs(a.lng - b.lng) < 0.000001;
  }

  function centerLockedMarker(id, latLng, options = {}) {
    if (state.lockedVehicleId !== id) return;
    state.map.setView(latLng, state.map.getZoom(), {
      animate: Boolean(options.animate),
      noMoveStart: true,
    });
  }

  function centerLockedVehicle(options = {}) {
    const vehicle = state.vehicles.find((v) => v.id === state.lockedVehicleId);
    if (!vehicle?.hasLocation) return;

    const marker = state.markers.get(vehicle.id);
    const latLng = marker?.getLatLng() || L.latLng(vehicle.lat, vehicle.lng);
    const zoom = Math.max(state.map.getZoom(), options.minZoom ?? 14);

    state.map.setView(latLng, zoom, {
      animate: Boolean(options.animate),
      noMoveStart: true,
    });
  }

  function createVehicleIcon(vehicle) {
    const selected = vehicle.id === state.selectedId ? 'selected' : '';
    return L.divIcon({
      className: '',
      html: `
        <div class="vehicle-marker ${vehicle.status} ${vehicle.vehicleType} ${selected}"
             style="--marker-color:${vehicle.color}">
          <span class="vehicle-emoji">${vehicleEmoji(vehicle.vehicleType)}</span>
          <span class="status-dot"></span>
        </div>
      `,
      iconSize: [58, 48],
      iconAnchor: [29, 42],
      popupAnchor: [0, -44],
    });
  }

  function vehicleEmoji(type) {
    const map = { truck: '🚛', van: '🚐', bike: '🏍️', car: '🚗' };
    return map[type] || '🚗';
  }

  function vehicleIconSvg(type) {
    const icons = {
      truck: `<svg class="vehicle-svg" viewBox="0 0 44 20" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="3" width="28" height="13" rx="1.5" fill="white" opacity="0.95"/>
        <rect x="0" y="5" width="28" height="11" rx="1" fill="rgba(0,0,0,0.07)"/>
        <path d="M28 5 L28 16 L40 16 L40 11 L35 5 Z" fill="rgba(255,255,255,0.92)"/>
        <rect x="30" y="6.5" width="7" height="5" rx="0.5" fill="rgba(0,0,0,0.3)"/>
        <rect x="40" y="7.5" width="1.5" height="5" rx="0.75" fill="rgba(255,255,255,0.65)"/>
        <circle cx="7"  cy="18" r="2.8" fill="rgba(0,0,0,0.55)"/>
        <circle cx="7"  cy="18" r="1.2" fill="rgba(255,255,255,0.25)"/>
        <circle cx="16" cy="18" r="2.8" fill="rgba(0,0,0,0.55)"/>
        <circle cx="16" cy="18" r="1.2" fill="rgba(255,255,255,0.25)"/>
        <circle cx="36" cy="18" r="2.8" fill="rgba(0,0,0,0.55)"/>
        <circle cx="36" cy="18" r="1.2" fill="rgba(255,255,255,0.25)"/>
        <rect x="0" y="3" width="4" height="2" rx="0.5" fill="rgba(255,240,80,0.7)"/>
      </svg>`,

      van: `<svg class="vehicle-svg" viewBox="0 0 34 20" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 15 L2 6 C2 4.5 3 4 5 4 L26 4 C30 4 33 7 33 11 L33 15 Z" fill="white" opacity="0.95"/>
        <rect x="4"  y="5.5" width="8"  height="5.5" rx="0.5" fill="rgba(0,0,0,0.25)"/>
        <rect x="14" y="5.5" width="8"  height="5.5" rx="0.5" fill="rgba(0,0,0,0.25)"/>
        <rect x="24" y="5.5" width="6"  height="5.5" rx="0.5" fill="rgba(0,0,0,0.38)"/>
        <rect x="2" y="14"  width="4"  height="2"   rx="0.5" fill="rgba(255,240,80,0.7)"/>
        <rect x="29" y="14" width="4"  height="2"   rx="0.5" fill="rgba(255,80,80,0.65)"/>
        <circle cx="8"  cy="17" r="3" fill="rgba(0,0,0,0.55)"/>
        <circle cx="8"  cy="17" r="1.3" fill="rgba(255,255,255,0.25)"/>
        <circle cx="26" cy="17" r="3" fill="rgba(0,0,0,0.55)"/>
        <circle cx="26" cy="17" r="1.3" fill="rgba(255,255,255,0.25)"/>
      </svg>`,

      bike: `<svg class="vehicle-svg" viewBox="0 0 36 22" xmlns="http://www.w3.org/2000/svg">
        <circle cx="7"  cy="16" r="5.5" stroke="white" stroke-width="2.5" fill="none"/>
        <circle cx="7"  cy="16" r="2"   fill="rgba(255,255,255,0.35)"/>
        <circle cx="29" cy="16" r="5.5" stroke="white" stroke-width="2.5" fill="none"/>
        <circle cx="29" cy="16" r="2"   fill="rgba(255,255,255,0.35)"/>
        <path d="M7 14 L14 6 L20 10 L29 14" stroke="white" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="11" y="3" width="6" height="2" rx="1" fill="white" opacity="0.9"/>
        <line x1="27" y1="8" x2="32" y2="11" stroke="white" stroke-width="2" stroke-linecap="round"/>
        <line x1="27" y1="8" x2="32" y2="6"  stroke="white" stroke-width="2" stroke-linecap="round"/>
      </svg>`,

      car: `<svg class="vehicle-svg" viewBox="0 0 36 20" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 14 L5 8 C6.5 5.5 9 5 12 5 L24 5 C27 5 29.5 5.5 31 8 L34 14 L34 17 L2 17 Z" fill="white" opacity="0.95"/>
        <path d="M8.5 5.5 L10 13 L26 13 L27.5 5.5 Z" fill="rgba(0,0,0,0.22)"/>
        <rect x="2"  y="14" width="5" height="2" rx="0.5" fill="rgba(255,240,80,0.75)"/>
        <rect x="29" y="14" width="5" height="2" rx="0.5" fill="rgba(255,80,80,0.7)"/>
        <circle cx="9"  cy="18.5" r="3.2" fill="rgba(0,0,0,0.55)"/>
        <circle cx="9"  cy="18.5" r="1.3" fill="rgba(255,255,255,0.25)"/>
        <circle cx="27" cy="18.5" r="3.2" fill="rgba(0,0,0,0.55)"/>
        <circle cx="27" cy="18.5" r="1.3" fill="rgba(255,255,255,0.25)"/>
      </svg>`,
    };
    return icons[type] || icons.car;
  }

  function getMarkerZIndex(vehicle) {
    if (vehicle.id === state.selectedId) return 1000;
    const ranks = { live: 900, stopped: 850, gps_bad: 700, delayed: 650, no_location: 600, recent: 500, old: 200 };
    return ranks[vehicle.status] ?? 300;
  }

  function renderFleetList() {
    const vehicles = filteredVehicles();
    const count = vehicles.length;
    els.mapTitle.textContent = `${count} veiculo${count === 1 ? '' : 's'} em exibicao`;

    if (!vehicles.length) {
      els.fleetList.innerHTML = '<div class="empty-detail" style="min-height:80px">Nenhum veiculo neste filtro</div>';
      return;
    }

    els.fleetList.innerHTML = vehicles.map((vehicle) => {
      const inView = vehicle.hasLocation && state.map.getBounds().contains([vehicle.lat, vehicle.lng]);
      const viewHint = vehicle.hasLocation ? (inView ? 'no mapa' : 'fora da tela') : 'sem coordenada';
      return `
        <article class="fleet-card ${vehicle.status} ${vehicle.id === state.selectedId ? 'active' : ''}" data-id="${vehicle.id}">
          <div class="vehicle-symbol ${vehicle.vehicleType}" style="background:${vehicle.color}">${vehicleEmoji(vehicle.vehicleType)}</div>
          <div class="fleet-main">
            <div class="fleet-line">
              <span class="fleet-name">${escapeHtml(vehicle.name)}</span>
              <span class="badge ${vehicle.status}">${escapeHtml(statusCopy[vehicle.status])}</span>
            </div>
            <p class="fleet-meta">${escapeHtml(formatAge(vehicle.minutesOld))} · ${escapeHtml(vehicle.speed)} km/h · ${viewHint}</p>
          </div>
        </article>
      `;
    }).join('');

    els.fleetList.querySelectorAll('.fleet-card').forEach((card) => {
      card.addEventListener('click', () => selectVehicle(card.dataset.id));
    });
  }

  function filteredVehicles() {
    return state.vehicles.filter((vehicle) => {
      const matchesSearch = !state.search
        || vehicle.name.toLowerCase().includes(state.search)
        || vehicle.address.toLowerCase().includes(state.search);

      if (!matchesSearch) return false;
      if (state.filter === 'live') return GOOD_STATUSES.includes(vehicle.status);
      if (state.filter === 'attention') return ATTENTION_STATUSES.includes(vehicle.status);
      if (state.filter === 'old') return vehicle.status === 'old';
      return true;
    }).sort((a, b) => {
      const aTime = Number.isFinite(a.minutesOld) ? a.minutesOld : Infinity;
      const bTime = Number.isFinite(b.minutesOld) ? b.minutesOld : Infinity;
      return aTime - bTime;
    });
  }

  function selectVehicle(id) {
    state.selectedId = id;
    const vehicle = state.vehicles.find((v) => v.id === id);
    state.lockedVehicleId = vehicle?.hasLocation ? id : null;

    // Centraliza sem animar para nao brigar com o follow do marcador.
    if (vehicle?.hasLocation) {
      state.map.setView([vehicle.lat, vehicle.lng], Math.max(state.map.getZoom(), 14), { animate: false });
    }

    renderMap();
    centerLockedVehicle({ animate: false, minZoom: 14 });

    if (vehicle?.hasLocation) {
      const marker = state.markers.get(id);
      if (marker) marker.openPopup();
    }

    renderFleetList();
    renderDetail();
    if (window.lucide) window.lucide.createIcons();
  }

  function deselectVehicle() {
    state.selectedId = null;
    state.lockedVehicleId = null;
    renderMap();
    renderFleetList();
    renderDetail();
    if (window.lucide) window.lucide.createIcons();
  }

  function renderDetail() {
    const vehicle = state.vehicles.find((v) => v.id === state.selectedId);
    if (!vehicle) {
      els.detailDrawer.innerHTML = `
        <div class="empty-detail">
          <i data-lucide="mouse-pointer-2"></i>
          <span>Selecione um veiculo</span>
        </div>
      `;
      return;
    }

    const mapsUrl = vehicle.hasLocation
      ? `https://www.google.com/maps?q=${vehicle.lat},${vehicle.lng}`
      : null;

    const wazeUrl = vehicle.hasLocation
      ? `https://waze.com/ul?ll=${vehicle.lat},${vehicle.lng}&navigate=yes`
      : null;

    els.detailDrawer.innerHTML = `
      <article class="detail-card">
        <header class="detail-header">
          <div>
            <p class="eyebrow">Rastreador</p>
            <h3>${escapeHtml(vehicle.name)}</h3>
          </div>
          <div class="detail-header-actions">
            <span class="badge ${vehicle.status}">${escapeHtml(statusCopy[vehicle.status])}</span>
            <button class="detail-close" type="button" title="Fechar" aria-label="Fechar painel">
              <i data-lucide="x"></i>
            </button>
          </div>
        </header>

        ${vehicle.gpsStale ? `
          <div class="stale-warning">
            <i data-lucide="triangle-alert"></i>
            <span>GPS inválido — posição pode estar desatualizada</span>
          </div>
        ` : ''}

        <p class="detail-address">${escapeHtml(vehicle.address)}</p>

        ${mapsUrl ? `
          <div class="detail-nav-links">
            <a class="nav-link" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">
              <i data-lucide="map-pin"></i> Google Maps
            </a>
            <a class="nav-link nav-link--waze" href="${escapeHtml(wazeUrl)}" target="_blank" rel="noopener">
              <i data-lucide="navigation"></i> Waze
            </a>
          </div>
        ` : ''}

        <div class="detail-grid">
          ${detailField('Ultima posicao', formatDate(vehicle.date))}
          ${detailField('Idade', formatAge(vehicle.minutesOld))}
          ${detailField('Velocidade', `${vehicle.speed} km/h`)}
          ${detailField('Ignicao', vehicle.ignition)}
          ${detailField('Sinal', vehicle.signal)}
          ${detailField('GPS', vehicle.gps || '-')}
          ${vehicle.hasLocation
            ? detailFieldCopy('Latitude', vehicle.lat.toFixed(6), `${vehicle.lat},${vehicle.lng}`)
            : detailField('Latitude', '-')}
          ${vehicle.hasLocation
            ? detailFieldCopy('Longitude', vehicle.lng.toFixed(6), null)
            : detailField('Longitude', '-')}
        </div>
      </article>
    `;

    els.detailDrawer.querySelector('.detail-close')?.addEventListener('click', deselectVehicle);

    const copyBtn = els.detailDrawer.querySelector('.coord-copy');
    if (copyBtn && vehicle.hasLocation) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(`${vehicle.lat},${vehicle.lng}`).then(() => {
          copyBtn.setAttribute('title', 'Copiado!');
          copyBtn.classList.add('copied');
          window.setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.setAttribute('title', 'Copiar coordenadas');
          }, 1500);
        });
      });
    }
  }

  function detailField(label, value) {
    return `<div class="detail-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function detailFieldCopy(label, value, coords) {
    const copyAttr = coords ? `data-coords="${escapeHtml(coords)}"` : '';
    return `
      <div class="detail-field detail-field--coords">
        <span>${escapeHtml(label)}</span>
        <div class="coord-row">
          <strong>${escapeHtml(value)}</strong>
          ${coords ? `<button class="coord-copy" type="button" title="Copiar coordenadas" ${copyAttr}><i data-lucide="copy"></i></button>` : ''}
        </div>
      </div>
    `;
  }

  function fitAllMarkers(animate = true) {
    const points = state.vehicles
      .filter((v) => v.hasLocation)
      .map((v) => [v.lat, v.lng]);

    if (!points.length) return;
    state.map.fitBounds(points, { animate, padding: [52, 52], maxZoom: 13 });
  }

  function parseBrazilianDate(value) {
    const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, day, month, year, hour, minute, second] = match.map(Number);
    return new Date(year, month - 1, day, hour, minute, second);
  }

  function parseBrazilianNumber(value) {
    const normalized = String(value || '').replace(',', '.');
    const number = Number.parseFloat(normalized);
    return Number.isFinite(number) ? number : NaN;
  }

  function slug(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  function removeAccents(value) {
    return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function formatDate(date) {
    if (!date || !Number.isFinite(date.getTime())) return '-';
    return date.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function formatClock(date) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatAge(minutes) {
    if (!Number.isFinite(minutes)) return 'sem horario';
    if (minutes < 1) return 'agora';
    if (minutes < 60) return `ha ${Math.floor(minutes)} min`;
    if (minutes < 1440) return `ha ${Math.floor(minutes / 60)} h`;
    return `ha ${Math.floor(minutes / 1440)} dias`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();

