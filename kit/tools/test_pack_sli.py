#!/usr/bin/env python3
"""test_pack_sli.py - pack_sli.py's tag reading: maxspeed values, per-direction limits, one-way roads, road classes.

    python3 kit/tools/test_pack_sli.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pack_sli as P  # noqa: E402

fails = 0


def check(got, want, what):
    global fails
    ok = got == want
    print(('ok   ' if ok else 'FAIL ') + what + ('' if ok else ': got %r, want %r' % (got, want)))
    if not ok:
        fails += 1


# maxspeed values
check(P.parse_limit('50'), (50, P.SRC_NUM), 'a number')
check(P.parse_limit(' 60 '), (60, P.SRC_NUM), 'spaces')
check(P.parse_limit('30 mph'), (48, P.SRC_NUM), 'mph to km/h')
check(P.parse_limit('50;70'), (50, P.SRC_NUM), 'several values: the first')
check(P.parse_limit('GE:urban'), (60, P.SRC_ZONE), 'GE:urban zone')
check(P.parse_limit('GE:rural'), (90, P.SRC_ZONE), 'GE:rural zone')
check(P.parse_limit('GE:motorway'), (110, P.SRC_ZONE), 'GE:motorway zone')
check(P.parse_limit('RU:living_street'), (20, P.SRC_ZONE), 'living street zone (any country)')
check(P.parse_limit('signals'), (0, P.SRC_VAR), 'variable signs')
check(P.parse_limit('none'), (0, P.SRC_NONE), 'none: nothing usable')
check(P.parse_limit('GE:trunk'), (0, P.SRC_NONE), 'an unknown zone')
check(P.parse_limit('3'), (0, P.SRC_NONE), 'too low')
check(P.parse_limit('500'), (0, P.SRC_NONE), 'too high')
check(P.parse_limit(''), (0, P.SRC_NONE), 'empty')

# per direction
check(P.limits({'maxspeed': '60'}), (60, P.SRC_NUM, 60, P.SRC_NUM), 'one limit both ways')
check(P.limits({'maxspeed:forward': '70', 'maxspeed:backward': '50'}), (70, P.SRC_NUM, 50, P.SRC_NUM), 'forward / backward')
check(P.limits({'maxspeed': '60', 'maxspeed:backward': '40'}), (60, P.SRC_NUM, 40, P.SRC_NUM), 'backward over a general limit')
check(P.limits({'source:maxspeed': 'GE:urban'}), (60, P.SRC_ZONE, 60, P.SRC_ZONE), 'the zone from source:maxspeed')
check(P.limits({'maxspeed': '50', 'maxspeed:type': 'GE:urban'}), (50, P.SRC_NUM, 50, P.SRC_NUM), 'a number wins over its zone')
check(P.limits({}), (0, P.SRC_NONE, 0, P.SRC_NONE), 'untagged')

# one-way
check(P.oneway_of({'oneway': 'yes'}, 3), (1, False), 'oneway=yes')
check(P.oneway_of({'oneway': '-1'}, 3), (-1, False), 'oneway=-1')
check(P.oneway_of({'junction': 'roundabout'}, 4), (1, True), 'a roundabout is one-way')
check(P.oneway_of({'highway': 'motorway'}, 0), (1, False), 'a motorway is one-way')
check(P.oneway_of({'highway': 'motorway', 'oneway': 'no'}, 0), (0, False), 'unless oneway=no')
check(P.oneway_of({}, 6), (0, False), 'two-way')

# classes
check(P.road_class({'highway': 'primary'}), 2, 'primary')
check(P.road_class({'highway': 'trunk_link'}), 1, 'a trunk ramp is trunk')
check(P.road_class({'highway': 'footway'}), -1, 'no footways')
check(P.road_class({'highway': 'residential', 'access': 'private'}), -1, 'no private roads')
check(P.road_class({'highway': 'service', 'access': 'private', 'motor_vehicle': 'destination'}), 8, 'private but open to cars going there')
check(P.road_class({'highway': 'pedestrian'}), -1, 'no pedestrian areas')

print()
if fails:
    print('%d failed' % fails)
    sys.exit(1)
print('ok')
