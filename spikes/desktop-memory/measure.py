"""Launch a desktop app, let it settle, and report the memory of its whole process tree.

Usage: python3 -I measure.py <label> [--settle S] [--samples N] -- <command...>

Prints one JSON line: median PSS, USS and RSS (MiB) summed over every process
in the launched session (webview, network and GPU helpers included),
resident GPU memory (DRM fdinfo), plus the per-process breakdown from the median sample.
"""

import argparse
import json
import os
import signal
import statistics
import subprocess
import sys
import time


def session_members(sid):
    """Every process in the session, which still includes helpers a launcher detached and exited from."""
    members = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as f:
                stat = f.read()
        except OSError:
            continue
        # comm may contain spaces or parens; the session id is the fourth field after the last ')'.
        if int(stat[stat.rindex(")") + 2 :].split()[3]) == sid:
            members.append(int(entry))
    return members


def memory_kib(pid):
    fields = {}
    with open(f"/proc/{pid}/smaps_rollup") as f:
        for line in f:
            parts = line.split()
            if len(parts) == 3 and parts[2] == "kB":
                fields[parts[0].rstrip(":")] = int(parts[1])
    with open(f"/proc/{pid}/comm") as f:
        comm = f.read().strip()
    return {
        "comm": comm,
        "pss": fields.get("Pss", 0),
        "uss": fields.get("Private_Clean", 0) + fields.get("Private_Dirty", 0),
        "rss": fields.get("Rss", 0),
    }


def gpu_clients_kib(pid):
    """Resident GPU memory per DRM client the process holds, keyed so a client open on several fds counts once."""
    clients = {}
    for fd in os.listdir(f"/proc/{pid}/fdinfo"):
        try:
            with open(f"/proc/{pid}/fdinfo/{fd}") as f:
                fields = dict(line.split(":", 1) for line in f if ":" in line)
        except OSError:
            continue
        if "drm-client-id" not in fields:
            continue
        key = (fields.get("drm-pdev", "").strip(), fields["drm-client-id"].strip())
        clients[key] = sum(
            int(value.split()[0]) for name, value in fields.items() if name.startswith("drm-resident-")
        )
    return clients


def sample(root):
    procs, gpu = [], {}
    for pid in session_members(root):
        try:
            procs.append({"pid": pid, **memory_kib(pid)})
            gpu.update(gpu_clients_kib(pid))
        except (OSError, ValueError):
            pass
    if not procs:
        sys.exit("every measured process has exited")
    totals = {key: sum(p[key] for p in procs) for key in ("pss", "uss", "rss")}
    totals["gpu"] = sum(gpu.values())
    return totals, procs


def mib(kib):
    return round(kib / 1024, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("label")
    parser.add_argument("--settle", type=float, default=20)
    parser.add_argument("--samples", type=int, default=10)
    if "--" not in sys.argv:
        parser.error("missing -- <command...>")
    split = sys.argv.index("--")
    args = parser.parse_args(sys.argv[1:split])
    command = sys.argv[split + 1 :]

    app = subprocess.Popen(command, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(args.settle)
        if not session_members(app.pid):
            sys.exit(f"{args.label}: every process exited before measuring")
        runs = []
        for _ in range(args.samples):
            runs.append(sample(app.pid))
            time.sleep(1)
    finally:
        try:
            os.killpg(app.pid, signal.SIGTERM)
            app.wait(timeout=10)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(app.pid, signal.SIGKILL)

    runs.sort(key=lambda run: run[0]["pss"])
    totals, procs = runs[len(runs) // 2]
    print(json.dumps({
        "label": args.label,
        "pss_mib": mib(statistics.median(run[0]["pss"] for run in runs)),
        "uss_mib": mib(statistics.median(run[0]["uss"] for run in runs)),
        "rss_mib": mib(statistics.median(run[0]["rss"] for run in runs)),
        "gpu_mib": mib(statistics.median(run[0]["gpu"] for run in runs)),
        "processes": [
            {"comm": p["comm"], "pss_mib": mib(p["pss"]), "uss_mib": mib(p["uss"])}
            for p in sorted(procs, key=lambda p: -p["pss"])
        ],
    }))


if __name__ == "__main__":
    main()
