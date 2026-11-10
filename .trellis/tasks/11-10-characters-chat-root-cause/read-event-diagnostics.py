"""Read-only event diagnostics; persist allowlisted, anonymized fields only."""
import concurrent.futures
import importlib.util
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sentry_api", "C:/Users/PRO6/.codex/plugins/cache/openai-curated-remote/sentry/0.1.2/skills/sentry/scripts/sentry_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
original_urlopen = api.urlopen
api.urlopen = lambda request: original_urlopen(request, timeout=20)
TOKEN = os.environ["SENTRY_AUTH_TOKEN"]
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f-]{27,}", re.I)

def path_only(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        path = UUID.sub(":id", parsed.path)
        path = re.sub(r"/[0-9]+(?=/|$)", "/:id", path)
        if "/collect/" in path:
            return "[telemetry]"
        return (parsed.hostname or "") + path
    except ValueError:
        return "[invalid path]"

def project(record):
    try:
        url = api.build_url("https://de.sentry.io", "/api/0/projects/wangqiao/st-miniapp/events/" + record["id"] + "/")
        data, _ = api.request_json(url, TOKEN)
        tags = {x["key"]: x["value"] for x in data.get("tags", [])}
        contexts = data.get("contexts", {})
        stall = contexts.get("page_stall", {})
        result = {
            **record, "timestamp": data.get("dateCreated") or data.get("datetime"),
            "tags": {k: tags[k] for k in ("route", "cold_start", "net_type", "tg_platform", "release", "os.name", "os.version") if k in tags},
            "waited_ms": stall.get("waitedMs"),
            "inflight_unavailable_count": sum(isinstance(x, str) for x in stall.get("inflight", [])),
            "inflight": [{"route": path_only(x.get("route")), "waited_ms": x.get("waitedMs")} for x in stall.get("inflight", []) if isinstance(x, dict)],
            "replay": tags.get("replayId") or contexts.get("replay", {}).get("replay_id"),
            "trace": contexts.get("trace", {}).get("trace_id"),
            "breadcrumbs": [], "exceptions": [],
        }
        for entry in data.get("entries", []):
            if entry.get("type") == "breadcrumbs":
                for crumb in entry.get("data", {}).get("values", []):
                    category = crumb.get("category", "")
                    fields = crumb.get("data") or {}
                    if category in ("fetch", "http", "navigation"):
                        result["breadcrumbs"].append({
                            "timestamp": crumb.get("timestamp"), "category": category,
                            "level": crumb.get("level"), "method": fields.get("method"),
                            "status": fields.get("status_code") or fields.get("status"),
                            "url": path_only(fields.get("url")),
                            "from": path_only(fields.get("from")),
                            "to": path_only(fields.get("to")),
                        })
                    elif category == "sentry.event":
                        message = crumb.get("message", "")
                        if any(v in message for v in ("findLast", "reading 'get'", "property 'get'", "parallelRoutes", "page_stall")):
                            result["breadcrumbs"].append({"timestamp": crumb.get("timestamp"), "category": category, "message": message[:180]})
            elif entry.get("type") == "exception":
                for error in entry.get("data", {}).get("values", []):
                    frames = error.get("stacktrace", {}).get("frames", [])
                    result["exceptions"].append({
                        "type": error.get("type"), "value": error.get("value", "")[:180],
                        "frames": [{"file": path_only(f.get("filename")), "function": f.get("function"), "line": f.get("lineNo"), "col": f.get("colNo"), "in_app": f.get("inApp")} for f in frames[-8:]]
                    })
        return result
    except Exception as error:
        return {**record, "error_type": type(error).__name__}

def main():
    records = json.loads((HERE / "event-input.json").read_text(encoding="utf-8"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(project, records))
    (HERE / "event-diagnostics.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for row in results:
        print(json.dumps({k: row.get(k) for k in ("id", "kind", "timestamp", "waited_ms", "inflight", "error_type")}, ensure_ascii=False))

if __name__ == "__main__":
    main()

