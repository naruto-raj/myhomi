import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
import csv

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
XLSX_PATH = DATA_DIR / "council-tax-levels-in-wales-2025-26.xlsx"
OUTPUT_PATH = DATA_DIR / "council_tax_band_d_wales_2025_26.csv"
LAD_LOOKUP_PATH = DATA_DIR / "Local_Authority_Districts_(April_2025)_Names_and_Codes_in_the_UK_v2.csv"

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
}


def read_shared_strings(zf):
    try:
        xml = zf.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(xml)
    strings = []
    for si in root.findall("main:si", NS):
        text_parts = [t.text or "" for t in si.findall(".//main:t", NS)]
        strings.append("".join(text_parts))
    return strings


def cell_value(cell, shared_strings):
    value = cell.find("main:v", NS)
    if value is None or value.text is None:
        return ""
    if cell.get("t") == "s":
        idx = int(value.text)
        return shared_strings[idx] if idx < len(shared_strings) else ""
    return value.text


def load_sheet(zf, shared_strings, sheet_path):
    xml = zf.read(sheet_path)
    root = ET.fromstring(xml)
    rows = []
    for row in root.findall(".//main:row", NS):
        cells = row.findall("main:c", NS)
        row_values = []
        for cell in cells:
            val = cell_value(cell, shared_strings)
            row_values.append(val)
        rows.append(row_values)
    return rows


def find_header_row(rows):
    header_idx = None
    header = None
    for idx, row in enumerate(rows[:60]):
        joined = " ".join(str(v).lower() for v in row if v is not None)
        if ("band" in joined and "d" in joined) and ("code" in joined or "authority" in joined or "local authority" in joined):
            header_idx = idx
            header = [str(v).strip() for v in row]
            break
        if "2025" in joined and ("band d" in joined or "bandd" in joined):
            header_idx = idx
            header = [str(v).strip() for v in row]
            break
    return header_idx, header


def find_col(headers, candidates):
    for i, name in enumerate(headers):
        lower = str(name).lower()
        for c in candidates:
            if c in lower:
                return i
    return -1


def find_band_column(headers):
    for i, name in enumerate(headers):
        lower = str(name).lower()
        if "band d" in lower and ("2025" in lower or "2025-26" in lower or "2025/26" in lower):
            return i
    for i, name in enumerate(headers):
        lower = str(name).lower()
        if "overall average band d" in lower:
            return i
    for i, name in enumerate(headers):
        lower = str(name).lower()
        if "band d" in lower:
            return i
    return -1


def guess_code_column(rows):
    best_idx = -1
    best_count = 0
    max_cols = max(len(r) for r in rows[:200]) if rows else 0
    for idx in range(max_cols):
        count = 0
        for row in rows[:200]:
            if len(row) <= idx:
                continue
            val = str(row[idx]).strip()
            if re.match(r"^W\\d{8}$", val):
                count += 1
        if count > best_count:
            best_count = count
            best_idx = idx
    return best_idx if best_count >= 3 else -1


def guess_band_column(rows, code_idx):
    if code_idx == -1:
        return -1
    best_idx = -1
    best_count = 0
    max_cols = max(len(r) for r in rows[:200]) if rows else 0
    for idx in range(max_cols):
        if idx == code_idx:
            continue
        count = 0
        for row in rows[:200]:
            if len(row) <= idx or len(row) <= code_idx:
                continue
            code_val = str(row[code_idx]).strip()
            if not re.match(r"^W\\d{8}$", code_val):
                continue
            raw = str(row[idx]).strip().replace(",", "")
            try:
                num = float(raw)
            except ValueError:
                continue
            if 300 <= num <= 4000:
                count += 1
        if count > best_count:
            best_count = count
            best_idx = idx
    return best_idx if best_count >= 3 else -1


def normalize_name(value):
    value = value.lower().strip()
    value = value.replace("&", "and")
    value = re.sub(r"[\(\)\.,']", "", value)
    value = re.sub(r"\s+", " ", value)
    return value


def load_lad_lookup():
    lookup = {}
    if not LAD_LOOKUP_PATH.exists():
        raise SystemExit(f"LAD lookup not found at {LAD_LOOKUP_PATH}")
    with LAD_LOOKUP_PATH.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            code = row.get("LAD25CD", "").strip()
            if not code.startswith("W"):
                continue
            name_en = row.get("LAD25NM", "").strip()
            name_cy = row.get("LAD25NMW", "").strip()
            if name_en:
                lookup[normalize_name(name_en)] = code
            if name_cy:
                lookup[normalize_name(name_cy)] = code
    return lookup


def main():
    xlsx = XLSX_PATH.resolve()
    if not xlsx.exists():
        raise SystemExit(f"XLSX not found at {xlsx}")

    lad_lookup = load_lad_lookup()

    with zipfile.ZipFile(xlsx) as zf:
        shared_strings = read_shared_strings(zf)
        sheet_files = [n for n in zf.namelist() if n.startswith("xl/worksheets/sheet")]
        if not sheet_files:
            raise SystemExit("No worksheets found in XLSX")

        selected_rows = None
        header_idx = None
        headers = None
        name_idx = -1
        band_idx = -1

        for sheet_path in sheet_files:
            rows = load_sheet(zf, shared_strings, sheet_path)
            header_idx, headers = find_header_row(rows)
            if header_idx is None or not headers:
                continue
            name_idx = find_col(headers, ["authority", "local authority"])
            band_idx = find_band_column(headers)
            if name_idx != -1 and band_idx != -1:
                selected_rows = rows
                break

    if selected_rows is None:
        raise SystemExit("Could not locate header row or columns in Wales XLSX")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        f.write("lad_code,authority,band_d_annual,year\n")
        for row in selected_rows[header_idx + 1 :]:
            if len(row) <= max(name_idx, band_idx):
                continue
            name = str(row[name_idx]).strip() if name_idx != -1 and len(row) > name_idx else ""
            band_raw = str(row[band_idx]).strip()
            if not name:
                continue
            lad_code = lad_lookup.get(normalize_name(name), "")
            if not lad_code:
                continue
            if not band_raw:
                continue
            try:
                band_val = float(band_raw.replace(",", ""))
            except ValueError:
                continue
            f.write(f"{lad_code},{name},{band_val},2025\n")

    print(f"Wrote {OUTPUT_PATH.resolve()}")


if __name__ == "__main__":
    main()
