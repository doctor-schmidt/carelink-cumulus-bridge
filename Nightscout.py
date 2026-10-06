#!/usr/local/bin/python3

import requests
from datetime import datetime

nightscout = "https://freestyle.fly.dev"

now = datetime.now().astimezone()
today = now.date()

def getIOB(bolus, minAgo):
    dia = 5
    scaleFactor = 3.0 / dia
    minAgo = scaleFactor * minAgo

    if minAgo < 75:
        x1 = minAgo / 5 + 1
        return bolus * (
            1 - 0.001852 * x1 * x1 + 0.001852 * x1
        )

    if minAgo < 180:
        x2 = (minAgo - 75) / 5
        return bolus * (
            0.001323 * x2 * x2
            - 0.054233 * x2
            + 0.55556
        )

    return 0.0

# Get treatments from Nightscout
response = requests.get(
    nightscout + "/api/v1/treatments",
    timeout=10
)
response.raise_for_status()
treatments = response.json()

# Today's boluses
injections = []

for treatment in treatments:
    if treatment.get("eventType") != "Bolus":
        continue
    insulin = treatment.get("insulin")
    timestamp = treatment.get("created_at")
    if insulin is None or not timestamp:
        continue
    dt = datetime.fromisoformat(
        timestamp.replace("Z", "+00:00")
    ).astimezone()
    if dt.date() != today:
        continue
    injections.append({
        "time": dt,
        "units": float(insulin),
    })

# Newest first
injections.sort(key=lambda x: x["time"], reverse=True)

# Total insulin
total = sum(
    injection["units"]
    for injection in injections
)

# IOB
total_iob = 0.0
for injection in injections:
    min_ago = (
        now - injection["time"]
    ).total_seconds() / 60
    total_iob += getIOB(
        injection["units"],
        min_ago
    )

print(
    f"\n   {now:%_H:%M}     "
    f"{total:g}u        "
    f"IOB {total_iob:.2f}u\n"
)
for number, injection in enumerate(injections, start=1):
    minutes = int(
        (now - injection["time"])
        .total_seconds() // 60
    )
    hours = minutes // 60
    mins = minutes % 60
    print(
        f"{number}  "
        f"{injection['time']:%_H:%M}      "
        f"{injection['units']:g}u    "
        f"{hours} {mins:02d}"
    )

print()
