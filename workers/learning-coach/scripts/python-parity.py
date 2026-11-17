"""Evaluate shared and boundary fixtures with the unchanged Python contracts."""

import json
from pathlib import Path
import sys
import unicodedata


sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))


def deny_network(event, args):
    if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto"):
        raise AssertionError("Network access is forbidden in contract parity checks")


sys.addaudithook(deny_network)
from services import learning_coach_contracts as contracts


results = []
for case in json.load(sys.stdin)["cases"]:
    try:
        operation = case["operation"]
        sources = case.get("verified_sources")
        if operation == "v1_response":
            contracts.validate_v1_response(case["value"], case["abstract"])
        elif operation == "v2_request":
            contracts.validate_request(case["request"], verified_sources=sources)
        elif operation == "v2_output":
            contracts.build_response(case["request"], case["output"], verified_sources=sources)
        elif operation == "v2_response":
            contracts.validate_response(case["request"], case["value"], verified_sources=sources)
        else:
            raise AssertionError("Unknown fixture operation")
        results.append({"name": case["name"], "valid": True})
    except contracts.ContractError as error:
        results.append({"name": case["name"], "valid": False, "error": error.code})
    except ValueError:
        if case["operation"] != "v1_response":
            raise
        results.append({"name": case["name"], "valid": False, "error": "invalid_v1"})
json.dump({"unicode_version": unicodedata.unidata_version, "results": results}, sys.stdout)
