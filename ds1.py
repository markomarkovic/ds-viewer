#!/usr/bin/env python3
"""Decoder for DreamSleep .ds1 CPAP logs.  See DS1_FORMAT.md.

Validated against a DS-6 AUTO CPAP.  WORKMODE below is the "DS" device-family
mapping; another family would need a different table (see README Limitations).

  ./ds1.py 13082026.ds1              summary per session
  ./ds1.py --csv 13082026.ds1        waveform to stdout
  ./ds1.py --export csv/ *.ds1       per-night waveforms + sessions.csv + events.csv
"""
import sys
import datetime as dt

TYPE = {0: "SWITCH", 1: "PARAM", 2: "P_A", 3: "EVENT", 4: "CP", 5: "STATE", 6: "SPO"}
EVENT = {0: "PRESS_UP", 1: "PRESS_DOWN", 2: "APNEA", 3: "SNORE", 4: "HYP", 5: "FH"}
PARAM = {
    0x00: "RampTime", 0x01: "HumidityLevel", 0x02: "AutoOn", 0x03: "AutoOff",
    0x04: "WorkMode", 0x05: "Pressure", 0x06: "MaxPress", 0x07: "MinPress",
    0x08: "IPAP", 0x09: "EPAP", 0x0A: "BackRate", 0x0B: "InspTime",
    0x0C: "InspTriggle", 0x0D: "ExpLevel", 0x0E: "HZ", 0x0F: "DeviceType",
    0x10: "Ver", 0x11: "InspSense", 0x13: "PressUnloading", 0x15: "PressDeclineTime",
    0x19: "IpTime", 0x1A: "TvSwitch", 0x1B: "TvValue", 0x21: "PressDiffer",
    0x25: "AutosMinPress", 0x26: "AutosMaxPress", 0x29: "ApcvMaxIpress",
    0x2A: "ApcvMinEpress",
    0x14: "PWM_4", 0x18: "PWM_10", 0x1C: "PWM_25",
    0x20: "P_0", 0x24: "P_4", 0x28: "P_10", 0x2C: "P_25",
    0x30: "F_0", 0x34: "F_4", 0x38: "F_10", 0x3C: "F_25",
}
# AnalysiHelper.GetModel: switch (iWorkMode - 2), for the "DS" device family
WORKMODE = {2: "CPAP", 3: "AUTO", 4: "S", 5: "ST", 6: "T", 7: "APCV"}

HZ = 10                 # hardcoded in AnalysisFileV2
FLOW_LPM = 0.12         # counts -> L/min (TV_mL = sum(flow)/5 at 10 Hz)


class Block:
    def __init__(self, date):
        self.sdate, self.stime = date, (12, 0, 0)
        self.edate = self.etime = None
        self.params, self.press, self.flow, self.events = {}, [], [], []

    @property
    def start(self):
        return dt.datetime(2000 + self.sdate[0], self.sdate[1], self.sdate[2], *self.stime)

    @property
    def seconds(self):
        return len(self.press) / HZ

    def param(self, key, scale=1):
        v = self.params.get(key)
        return None if v is None else v / scale


def parse(path):
    """Return the list of session blocks in a .ds1 file."""
    data = open(path, "rb").read()
    blocks, cur = [], None
    for i in range(0, len(data) - 3, 4):
        b0, b1, b2, b3 = data[i:i + 4]
        if not b0 & 0x80:
            continue
        rtype, sub = (b0 & 0x78) >> 3, b0 & 0x07
        if rtype == 0:
            if sub == 0:
                cur = Block((b1, b2, b3))
                blocks.append(cur)
            elif cur is None:
                continue
            elif sub == 1:
                cur.stime = (b1, b2, b3)
            elif sub == 2:
                cur.edate = (b1, b2, b3)
            elif sub == 3:
                cur.etime = (b1, b2, b3)
        elif cur is None:
            continue
        elif rtype == 1:
            cur.params[b1] = (b2 << 7) + b3
        elif rtype == 2:
            cur.press.append(((b0 & 0x07) << 9) + (b1 << 2) + ((b2 & 0x60) >> 5))
            cur.flow.append(((b2 & 0x1F) << 7) + b3)
        elif rtype == 3:
            cur.events.append((len(cur.press), EVENT.get(sub, sub), b1, b2, b3))
    return blocks


def lowpass(x, a):
    """Two-pass EMA, matching AnalysisFileV2.LowPass_Float."""
    a /= 100.0
    y, prev = list(x), x[0]
    for i in range(len(y)):
        y[i] = prev * (1 - a) + y[i] * a
        prev = y[i]
    prev = y[-1]
    for i in range(len(y) - 1, -1, -1):
        y[i] = prev * (1 - a) + y[i] * a
        prev = y[i]
    return y


def summarise(block):
    n = len(block.press)
    p = sorted(block.press)
    # the app low-passes pressure before taking the max; the raw peak runs 1-2 cmH2O high
    smooth_p = lowpass(block.press, 20)
    flow, base = lowpass(block.flow, 50), lowpass(block.flow, 3)
    counts = {}
    for _, name, _, _, _ in block.events:
        counts[name] = counts.get(name, 0) + 1
    hours = block.seconds / 3600
    mode = block.params.get(0x04)
    return {
        "start": block.start,
        "hours": hours,
        "mode": WORKMODE.get(mode, mode),
        "set_min": block.param(0x07, 10), "set_max": block.param(0x06, 10),
        "ramp_min": block.param(0x00), "humidity": block.param(0x01),
        "p_mean": int(sum(block.press) / n) / 10,   # matches the app's "Avg. Pressure"
        "p_median": p[n // 2] / 10,
        "p_max": max(smooth_p) / 10,                # matches the app's "Max. Pressure"
        "leak_median": sorted(base)[n // 2] * FLOW_LPM,
        "peak_flow": max(flow) * FLOW_LPM,
        "events": counts,
        "ai": counts.get("APNEA", 0) / hours if hours else 0,
    }


WAVE_HEADER = "session,t_s,timestamp,pressure_cmh2o,flow_lpm\n"


def waveform_rows(block, session):
    """Yield CSV lines at 10 Hz.  Timestamps are device-RTC (see DS1_FORMAT.md)."""
    start = block.start
    press, flow = block.press, block.flow
    for sec in range(0, len(press), HZ):
        stamp = (start + dt.timedelta(seconds=sec // HZ)).strftime("%Y-%m-%d %H:%M:%S")
        for k in range(min(HZ, len(press) - sec)):
            i = sec + k
            yield (f"{session},{i / HZ:.1f},{stamp}.{k},"
                   f"{press[i] / 10:.1f},{flow[i] * FLOW_LPM:.2f}\n")


def export(paths, outdir):
    import os
    os.makedirs(outdir, exist_ok=True)
    sessions = [("file,session,start,end,hours,samples,mode,set_min_cmh2o,set_max_cmh2o,"
                 "ramp_min,humidity,avg_pressure_cmh2o,median_pressure_cmh2o,"
                 "max_pressure_cmh2o,median_leak_lpm,apnea,press_up,press_down\n")]
    events = ["file,session,t_s,timestamp,event,d1,d2,d3\n"]
    total = 0
    for path in paths:
        name = os.path.basename(path).rsplit(".", 1)[0]
        blocks = [b for b in parse(path) if b.press]
        with open(os.path.join(outdir, name + ".csv"), "w") as fh:
            fh.write(WAVE_HEADER)
            for si, b in enumerate(blocks, 1):
                fh.writelines(waveform_rows(b, si))
                total += len(b.press)
        for si, b in enumerate(blocks, 1):
            s = summarise(b)
            end = b.start + dt.timedelta(seconds=b.seconds)
            c = s["events"]
            sessions.append(
                f"{name},{si},{b.start:%Y-%m-%d %H:%M:%S},{end:%Y-%m-%d %H:%M:%S},"
                f"{s['hours']:.4f},{len(b.press)},{s['mode']},{s['set_min']:g},"
                f"{s['set_max']:g},{s['ramp_min']:g},{s['humidity']:g},"
                f"{s['p_mean']:.1f},{s['p_median']:.1f},{s['p_max']:.1f},"
                f"{s['leak_median']:.1f},{c.get('APNEA', 0)},"
                f"{c.get('PRESS_UP', 0)},{c.get('PRESS_DOWN', 0)}\n")
            for idx, ev, d1, d2, d3 in b.events:
                stamp = b.start + dt.timedelta(seconds=idx / HZ)
                events.append(f"{name},{si},{idx / HZ:.1f},"
                              f"{stamp:%Y-%m-%d %H:%M:%S},{ev},{d1},{d2},{d3}\n")
        print(f"  {name}  {len(blocks)} session(s)")
    open(os.path.join(outdir, "sessions.csv"), "w").writelines(sessions)
    open(os.path.join(outdir, "events.csv"), "w").writelines(events)
    print(f"\n{len(paths)} nights, {len(sessions) - 1} sessions, {total} samples "
          f"({total / HZ / 3600:.1f} h) -> {outdir}/")


def write_csv(paths, out):
    """Same columns as --export, so stdout and the exported files agree."""
    out.write(WAVE_HEADER)
    for path in paths:
        for si, b in enumerate([b for b in parse(path) if b.press], 1):
            out.writelines(waveform_rows(b, si))


def main(argv):
    args = argv[1:]
    if "--export" in args:
        i = args.index("--export")
        outdir = args[i + 1]
        paths = [a for a in args[i + 2:] if not a.startswith("-")]
        return export(paths, outdir)
    paths = [a for a in args if not a.startswith("-")]
    if "--csv" in args:
        try:
            write_csv(paths, sys.stdout)
            sys.stdout.flush()
        except BrokenPipeError:
            # a downstream reader closed early (`| head`).  Point stdout at
            # /dev/null so the interpreter's final flush cannot raise again,
            # then exit as a SIGPIPE'd unix tool would.
            import os
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
            sys.exit(141)
        return
    for path in paths:
        blocks = parse(path)
        print(f"\n{path}  ({len(blocks)} session(s))")
        for b in blocks:
            if not b.press:
                print("  empty block")
                continue
            s = summarise(b)
            print(f"  {s['start']:%Y-%m-%d %H:%M:%S}  {s['hours']:.2f} h  "
                  f"{s['mode']} {s['set_min']:g}-{s['set_max']:g} cmH2O  "
                  f"ramp {s['ramp_min']:g} min  humidity {s['humidity']:g}")
            print(f"    pressure  avg {s['p_mean']:.1f}  median {s['p_median']:.1f}  "
                  f"max {s['p_max']:.1f} cmH2O")
            print(f"    leak      median {s['leak_median']:.1f} L/min   "
                  f"peak flow {s['peak_flow']:.0f} L/min")
            # device-flagged events; the PC software re-scores these from the flow channel
            # and reports different counts - see DS1_FORMAT.md
            print(f"    events    {s['events'] or 'none'}   AI {s['ai']:.1f}/h (device-flagged)")


if __name__ == "__main__":
    main(sys.argv)
