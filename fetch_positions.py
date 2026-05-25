#!/usr/bin/env python3
import argparse
import csv
import html
import json
import logging
import os
import re
import tempfile
import time
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9 fallback
    ZoneInfo = None


BASE_URL = "https://positronrt.com.br/rastreador5"
CSV_HEADER_NOTE = ["", "", "Posicoes de Todos Veiculos", "", "", "", "", "", "", "", "", "", ""]
CSV_HEADERS = [
    "Rastreador",
    "Horario",
    "",
    "Endereco",
    "Latitude",
    "Longitude",
    "Velocidade",
    "Ignicao",
    "Bateria",
    "Sinal",
    "GPS",
    "Temp.",
    "Umid.",
]


class PositronError(RuntimeError):
    pass


class WebSession:
    def __init__(self):
        self.cookie_jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookie_jar))
        self.headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/147.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }

    def update_headers(self, values):
        self.headers.update(values)

    def get(self, url, timeout):
        return self._open("GET", url, None, timeout)

    def post(self, url, data, timeout):
        body = urllib.parse.urlencode(data).encode("utf-8")
        return self._open("POST", url, body, timeout)

    def _open(self, method, url, body, timeout):
        headers = dict(self.headers)
        if body is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        with self.opener.open(request, timeout=timeout) as response:
            raw = response.read()
            charset = response.headers.get_content_charset() or "ISO-8859-1"
            text = raw.decode(charset, errors="replace")
            return SimpleResponse(response.status, response.geturl(), text)


class SimpleResponse:
    def __init__(self, status_code, url, text):
        self.status_code = status_code
        self.url = url
        self.text = text


def brazil_tz():
    if ZoneInfo:
        try:
            return ZoneInfo("America/Sao_Paulo")
        except Exception:
            pass
    return timezone(timedelta(hours=-3))


def new_session():
    return WebSession()


def extract_view_state(text):
    match = re.search(r'name="javax\.faces\.ViewState"[^>]+value="([^"]+)"', text)
    if match:
        return html.unescape(match.group(1))

    match = re.search(r'<update id="[^"]*ViewState[^"]*"><!\[CDATA\[([^\]]+)', text)
    if match:
        return html.unescape(match.group(1))

    raise PositronError("ViewState nao encontrado na resposta do Positron.")


def login(session, username, password, timeout):
    session.get(f"{BASE_URL}/login.xhtml", timeout)
    session.update_headers(
        {
            "Origin": "https://positronrt.com.br",
            "Referer": f"{BASE_URL}/login.xhtml",
        }
    )

    response = session.post(
        f"{BASE_URL}/loginProcess.xhtml",
        data={
            "j_username": username,
            "j_password": password,
            "_spring_security_remember_me": "on",
        },
        timeout=timeout,
    )

    if response.status_code != 200 or "init.xhtml" not in response.url:
        raise PositronError(f"Login recusado pelo Positron. Status={response.status_code} Url={response.url}")

    page = session.get(f"{BASE_URL}/position.xhtml", timeout)
    if "tablePositionsForm" not in page.text:
        raise PositronError("Pagina de posicoes nao carregou apos login.")
    return extract_view_state(page.text)


def ajax_headers(session):
    session.update_headers(
        {
            "Faces-Request": "partial/ajax",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/xml, text/xml, */*; q=0.01",
            "Referer": f"{BASE_URL}/position.xhtml",
        }
    )


def select_all_trackers(session, view_state, timeout):
    ajax_headers(session)
    response = session.post(
        f"{BASE_URL}/position.xhtml",
        data={
            "javax.faces.partial.ajax": "true",
            "javax.faces.source": "selectionForm:selectionType",
            "javax.faces.partial.execute": "selectionForm",
            "javax.faces.partial.render": "selectionForm tablePositionsForm",
            "javax.faces.behavior.event": "valueChange",
            "javax.faces.partial.event": "change",
            "selectionForm": "selectionForm",
            "selectionForm:selectionType_input": "all",
            "selectionForm:vehicleSelection_input": "",
            "selectionForm:vehicleSelection_hinput": "",
            "javax.faces.ViewState": view_state,
        },
        timeout=timeout,
    )
    if response.status_code != 200:
        raise PositronError(f"Falha ao selecionar rastreadores. Status={response.status_code}")
    if "<partial-response" not in response.text:
        raise PositronError("Selecao de todos os rastreadores nao retornou resposta AJAX.")
    return extract_view_state(response.text)


def extract_ajax_args(text):
    match = re.search(r'<extension[^>]+type="args"[^>]*>(.*?)</extension>', text, flags=re.S)
    if not match:
        raise PositronError("Resposta de posicoes sem bloco de argumentos PrimeFaces.")
    return json.loads(html.unescape(match.group(1)))


def load_positions(session, view_state, timeout, max_attempts=5):
    ajax_headers(session)
    for attempt in range(1, max_attempts + 1):
        response = session.post(
            f"{BASE_URL}/position.xhtml",
            data={
                "javax.faces.partial.ajax": "true",
                "javax.faces.source": "tablePositionsForm:loadPositions",
                "javax.faces.partial.execute": "tablePositionsForm:loadPositions",
                "javax.faces.partial.render": "tablePositionsForm",
                "tablePositionsForm": "tablePositionsForm",
                "tablePositionsForm:loadPositions": "tablePositionsForm:loadPositions",
                "javax.faces.ViewState": view_state,
            },
            timeout=timeout,
        )
        if response.status_code != 200:
            raise PositronError(f"Falha ao carregar posicoes. Status={response.status_code}")
        view_state = extract_view_state(response.text)
        args = extract_ajax_args(response.text)
        features_payload = args.get("features") or "{}"
        collection = json.loads(features_payload)
        features = collection.get("features") or []
        if args.get("loaded", True) and features:
            return features
        logging.info("Posicoes ainda carregando no Positron, tentativa %s/%s.", attempt, max_attempts)
        time.sleep(2)

    raise PositronError("Positron nao retornou posicoes carregadas.")


def normalize_label(label):
    label = re.sub(r"\s+", " ", label or "").strip()
    label = label.replace("( ", "(").replace(" )", ")")
    return label


def format_timestamp(milliseconds):
    if not milliseconds:
        return ""
    dt = datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc).astimezone(brazil_tz())
    return dt.strftime("%d/%m/%Y %H:%M:%S")


def format_decimal(value):
    if value is None:
        return ""
    return f"{float(value):.5f}".replace(".", ",")


def format_ignition(value):
    if value is True:
        return "Ligada"
    if value is False:
        return "Desligada"
    return "-"


def format_battery(value):
    if value is None:
        return ""
    try:
        return "Carregado" if float(value) >= 250 else str(value)
    except (TypeError, ValueError):
        return str(value)


def format_gps(position):
    if position.get("estimated"):
        return "GPS Estimado"
    return "GPS Valido" if position.get("validGPS") else "GPS Invalido"


def feature_to_row(feature):
    properties = feature.get("properties") or {}
    trackable = properties.get("trackable") or {}
    position = properties.get("position") or {}
    latitude = position.get("latitude")
    longitude = position.get("longitude")

    return [
        normalize_label(trackable.get("label")),
        format_timestamp(position.get("time")),
        "",
        position.get("address") or "",
        format_decimal(latitude),
        format_decimal(longitude),
        f"{int(position.get('speed') or 0)} km/h",
        format_ignition(position.get("ignition")),
        format_battery(position.get("batteryLevel")),
        position.get("communicationType") or "",
        format_gps(position),
        "",
        "",
    ]


def write_csv(features, csv_path):
    rows = [feature_to_row(feature) for feature in features]
    rows = [row for row in rows if row[0] and row[4] and row[5]]
    if not rows:
        raise PositronError("Nenhuma posicao valida para gravar.")

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", newline="", encoding="utf-8", delete=False, dir=csv_path.parent) as tmp:
        writer = csv.writer(tmp, delimiter=";", lineterminator="\n")
        writer.writerow(CSV_HEADER_NOTE)
        writer.writerow(CSV_HEADERS)
        writer.writerows(rows)
        temp_name = tmp.name

    os.replace(temp_name, csv_path)
    return len(rows)


def fetch_once(args):
    username = os.getenv("POSITRON_USER")
    password = os.getenv("POSITRON_PASS")
    if not username or not password:
        raise PositronError("Defina POSITRON_USER e POSITRON_PASS no ambiente.")

    session = new_session()
    view_state = login(session, username, password, args.timeout)
    view_state = select_all_trackers(session, view_state, args.timeout)
    features = load_positions(session, view_state, args.timeout)
    count = write_csv(features, args.csv_path)
    logging.info("CSV atualizado com %s veiculos em %s.", count, args.csv_path)
    return count


def parse_args():
    parser = argparse.ArgumentParser(description="Atualiza o CSV da Central de Rotas com dados do Positron.")
    parser.add_argument("--csv-path", type=Path, default=Path(__file__).resolve().parent / "data" / "latest-positions.csv")
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--once", action="store_true")
    return parser.parse_args()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()

    while True:
        try:
            fetch_once(args)
        except Exception:
            logging.exception("Falha ao atualizar posicoes.")
            if args.once:
                raise

        if args.once:
            return
        time.sleep(max(5, args.interval))


if __name__ == "__main__":
    main()
