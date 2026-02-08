import csv
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ODS_PATH = Path("./data/Band_D_2025-26.ods")
OUTPUT_PATH = Path("./data/council_tax_band_d_2025_26.csv")

NS = {
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}


def read_row(row):
    out = []
    for cell in row.findall("table:table-cell", NS):
        repeat = int(cell.get(f"{{{NS['table']}}}number-columns-repeated", "1"))
        text_p = cell.find("text:p", NS)
        text = text_p.text if text_p is not None else ""
        out.extend([text] * repeat)
    return out


def main():
    ods = ODS_PATH.resolve()
    if not ods.exists():
        raise SystemExit(f"ODS not found at {ods}")

    with zipfile.ZipFile(ods) as zf:
        xml = zf.read("content.xml")
    root = ET.fromstring(xml)

    sheet = None
    for s in root.findall(".//table:table", NS):
        if s.get(f"{{{NS['table']}}}name") == "Area_CT":
            sheet = s
            break
    if sheet is None:
        raise SystemExit("Area_CT sheet not found in ODS")

    rows = sheet.findall("table:table-row", NS)
    header = read_row(rows[2])
    while header and header[-1] == "":
        header.pop()
    try:
        year_col = header.index("2025 to 2026")
    except ValueError as exc:
        raise SystemExit("Year column not found (expected '2025 to 2026')") from exc

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["lad_code", "authority", "band_d_annual", "year"])
        for row in rows[3:]:
            vals = read_row(row)
            if len(vals) <= year_col:
                continue
            lad_code = (vals[1] or "").strip()
            authority = (vals[2] or "").strip()
            band_d = (vals[year_col] or "").strip()
            if not lad_code or not authority:
                continue
            if lad_code in ("[z]", "z", "Z"):
                continue
            if not band_d or band_d in ("[z]", "z", "Z"):
                continue
            try:
                band_d_val = float(str(band_d).replace(",", ""))
            except ValueError:
                continue
            writer.writerow([lad_code, authority, band_d_val, 2025])

    print(f"Wrote {OUTPUT_PATH.resolve()}")


if __name__ == "__main__":
    main()
