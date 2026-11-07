# Writes the made-up PDFs that src/ai/pdf-read.test.ts reads, into src/ai/fixtures:
#   python3 apps/app/scripts/make-pdf-fixtures.py
# Needs pypdf, and cryptography for the locked statement's AES-128. Every name, address, card number and figure is made up.
# The locked file's random file id and keys change on each run; its text and password do not.
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

OUT = Path(__file__).resolve().parent.parent / "src" / "ai" / "fixtures"
LOCKED_PASSWORD = "1234"

# A card statement whose parts add up to its total: 20,000.00 - 15,000.00 - 1,200.00 + 8,450.50 + 3,000.00 + 412.25 + 0.00 = 15,662.75.
STATEMENT = [
    (60, 740, "SAMPLE BANK PLATINUM MASTERCARD"),
    (60, 726, "5412 7512 3456 7890"),
    (330, 700, "Statement Date"),
    (500, 700, "OCT 05 2026"),
    (330, 686, "Payment Due Date"),
    (500, 686, "OCT 29 2026"),
    (330, 672, "Previous Balance"),
    (500, 672, "20,000.00"),
    (330, 658, "Less: Payments"),
    (500, 658, "15,000.00"),
    (330, 644, "Credits"),
    (500, 644, "1,200.00"),
    (330, 630, "Plus: Purchases"),
    (500, 630, "8,450.50"),
    (330, 616, "Installment"),
    (500, 616, "3,000.00"),
    (330, 602, "Finance Charges"),
    (500, 602, "412.25"),
    (330, 588, "Fees"),
    (500, 588, "0.00"),
    (330, 574, "Total Amount Due"),
    (500, 574, "15,662.75"),
    (330, 560, "Minimum Amount Due"),
    (500, 560, "850.00"),
    (60, 560, "Available Credit"),
    (200, 560, "84,337.25"),
    (60, 520, "Questions? cards@samplebank.example or +63 2 8888 1234"),
]

# A Spanish shop receipt for 10,55 EUR.
RECEIPT = [
    (60, 740, "SUPERMERCADO EJEMPLO S.L."),
    (60, 726, "Calle Ejemplo 1, 28001 Madrid"),
    (60, 700, "FACTURA SIMPLIFICADA 2026-000123"),
    (360, 700, "14/10/2026 18:42"),
    (60, 680, "LECHE ENTERA 1L x2"),
    (360, 680, "1,98"),
    (60, 666, "ARROZ JAZMIN 1KG"),
    (360, 666, "2,45"),
    (60, 652, "POLLO MUSLOS"),
    (360, 652, "6,12"),
    (60, 630, "TOTAL (EUR)"),
    (360, 630, "10,55"),
    (60, 616, "TARJETA **** 0000"),
    (360, 616, "10,55"),
]


def escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write(name: str, lines: list[tuple[int, int, str]] | None, password: str | None = None) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    if lines:
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        stream = DecodedStreamObject()
        stream.set_data("\n".join(f"BT /F1 9 Tf {x} {y} Td ({escape(text)}) Tj ET" for x, y, text in lines).encode("latin-1"))
        page[NameObject("/Contents")] = writer._add_object(stream)
    if password is not None:
        writer.encrypt(user_password=password, algorithm="AES-128")
    with open(OUT / name, "wb") as f:
        writer.write(f)


write("blank.pdf", None)
write("statement.pdf", STATEMENT)
write("statement-locked.pdf", STATEMENT, LOCKED_PASSWORD)
write("receipt.pdf", RECEIPT)
print(f"Wrote blank.pdf, statement.pdf, statement-locked.pdf (password {LOCKED_PASSWORD}) and receipt.pdf to {OUT}")
