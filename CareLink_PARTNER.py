import json
from datetime import datetime

now = datetime.now()
today = now.date()

def getIOB(bolus, minAgo):
    dia = 5
    scaleFactor = 3.0 / dia
    minAgo = scaleFactor * minAgo
    iob = 0.0
    if minAgo < 75:
        x1 = minAgo / 5 + 1
        iob = bolus * (1 - 0.001852 * x1 * x1 + 0.001852 * x1)
    else:
        if minAgo < 180:
            x2 = (minAgo - 75) / 5
            iob = bolus * (0.001323 * x2 * x2 - 0.054233 * x2 + 0.55556)
    return iob

with open("cumulus-response.json", "r") as f:
    data = json.load(f)

injections = []

for marker in data.get("markers", []):
    if marker.get("type") not in ("MANUAL_BOLUS", "INPEN_BOLUS"):
        continue

    timestamp = marker.get("timestamp")
    insulin_units = marker.get("data", {}).get("dataValues", {}).get("insulinUnits")

    if not timestamp or insulin_units is None:
        continue

    dt = datetime.fromisoformat(timestamp)

    if dt.date() != today:
        continue

    injections.append({
        "time": dt,
        "units": float(insulin_units),
    })

total = sum(x["units"] for x in injections)

total_iob = 0.0

for injection in injections:
    min_ago = (now - injection["time"]).total_seconds() / 60
    iob = getIOB(injection["units"], min_ago)
    total_iob += iob
    
print(f"\n   {total:g}u   {len(injections)}   IOB {total_iob:.2f}u\n")

for injection in injections:
    elapsed = datetime.now() - injection["time"]
    minutes = int(elapsed.total_seconds() // 60)
    hours = minutes // 60
    mins = minutes % 60

    print(
        f"{injection['time']:%H:%M}   "
        f"{injection['units']:g}u   "
        f"{hours}{mins:02d}"
    )
print()