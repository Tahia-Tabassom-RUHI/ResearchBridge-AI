"""Export the existing Python contract's Unicode semantics for the Worker."""

import json
from pathlib import Path
import sys
import unicodedata


def ranges(predicate):
    result = []
    for number in range(0x110000):
        if predicate(chr(number)):
            if result and result[-1][1] + 1 == number:
                result[-1][1] = number
            else:
                result.append([number, number])
    return result


data = {
    "unicode_version": unicodedata.unidata_version,
    "casefold": {str(n): chr(n).casefold() for n in range(0x110000) if chr(n).casefold() != chr(n)},
    "whitespace": ranges(str.isspace),
    "word": ranges(lambda c: c.isalnum() or c == "_"),
    "decimal": ranges(lambda c: unicodedata.category(c) == "Nd"),
    "letter": ranges(lambda c: unicodedata.category(c).startswith("L")),
    "number": ranges(lambda c: unicodedata.category(c).startswith("N")),
}
path = Path(__file__).resolve().parents[1] / "src" / "contracts" / "python-unicode.json"
if "--write" in sys.argv:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote Unicode {unicodedata.unidata_version} contract tables.")
elif json.loads(path.read_text(encoding="utf-8")) != data:
    raise SystemExit("Python Unicode semantics differ; review and refresh the Worker tables before release.")
else:
    print(f"Unicode {unicodedata.unidata_version} contract tables match Python.")
