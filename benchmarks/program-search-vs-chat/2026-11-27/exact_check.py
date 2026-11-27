"""Exact re-check of a construction for two published problems, written from their statements in rational arithmetic.

    python3 -I exact_check.py first-autocorrelation CONSTRUCTION.json [--bound DECIMAL]
    python3 -I exact_check.py circle-packing CONSTRUCTION.json [--bound DECIMAL]

It imports nothing from the scorer it checks: only the standard library, so a floating-point rounding in the scorer
cannot reach its verdict. Each number in the file is read two ways, both exact rationals: as the IEEE binary64 value a
JSON parser hands numpy (the reading the published scorer sees) and as the decimal the JSON text writes.

first-autocorrelation (the autocorrelation inequality's upper-bound constant C_1a, Problem 6.2 of arXiv:2511.02864):
    values f_0 .. f_{n-1} >= 0 with a positive sum, a step function on [-1/4, 1/4] with dx = 1/(2n), and
    C = max_k (sum_{i+j=k} f_i f_j) dx / (sum_i f_i dx)^2 = 2n max_k conv_k / S^2.
    The autoconvolution is exact: the values are scaled to integers over their common denominator, which cancels in C,
    and squared as one integer by Kronecker substitution.

circle-packing (26 circles in the unit square, maximise the sum of radii, Problem 6.36 of arXiv:2511.02864):
    26 triples (x, y, r) with r > 0, r <= x <= 1 - r, r <= y <= 1 - r and (x_i - x_j)^2 + (y_i - y_j)^2 >= (r_i + r_j)^2.
    Published packings meet these only to a floating-point tolerance, so the check also certifies a lower bound: every
    radius shrunk by one rational delta that provably clears each violated constraint, giving an exactly feasible
    packing whose sum is the certified value. For a pair with R = r_i + r_j and squared distance d2 < R^2, the overlap
    R - sqrt(d2) = (R^2 - d2) / (R + sqrt(d2)) is at most (R^2 - d2) / R, so delta = (R^2 - d2) / (2R) clears it.

It prints one JSON object: the exact value under each reading as a 40-digit decimal, every violated constraint, and,
with --bound, whether each reading's exactly feasible value strictly beats that bound (below it for C, above it for the
sum of radii). It exits 0 when every reading is exactly feasible or certifies a feasible shrink.
"""
import argparse
import json
import sys
from decimal import Decimal, localcontext
from fractions import Fraction
from math import lcm


def readings(path):
    """The file's numbers read as binary64 floats and as exact decimals, each turned into exact rationals."""
    text = open(path, encoding="utf-8").read()
    binary = json.loads(text, parse_float=lambda s: Fraction(float(s)), parse_int=Fraction)
    decimal = json.loads(text, parse_float=Fraction, parse_int=Fraction)
    return {"binary64": binary, "decimal": decimal}


def digits(value, places=40):
    with localcontext() as context:
        context.prec = places
        return str(Decimal(value.numerator) / Decimal(value.denominator))


def integer_scaled(values):
    """Integers M_i and their common denominator D with M_i / D == values[i] exactly."""
    denominator = 1
    for value in values:
        denominator = lcm(denominator, value.denominator)
    return [value.numerator * (denominator // value.denominator) for value in values], denominator


def autoconvolution_max(integers):
    """max_k sum_{i+j=k} M_i M_j for non-negative integers, exactly, by packing them into one integer and squaring it."""
    n = len(integers)
    width = 2 * max(1, max(integers).bit_length()) + n.bit_length() + 1  # a slot holds any convolution term without carry
    width_bytes = (width + 7) // 8
    packed = int.from_bytes(b"".join(m.to_bytes(width_bytes, "little") for m in integers), "little")
    square = (packed * packed).to_bytes(width_bytes * (2 * n), "little")
    return max(int.from_bytes(square[k * width_bytes:(k + 1) * width_bytes], "little") for k in range(2 * n - 1))


def first_autocorrelation(data):
    values = data.get("values") if isinstance(data, dict) else None
    if not isinstance(values, list) or len(values) == 0:
        return {"valid": False, "violations": ["values must be a non-empty array"]}
    if any(not isinstance(value, Fraction) for value in values):
        return {"valid": False, "violations": ["every value must be a number"]}
    negative = [index for index, value in enumerate(values) if value < 0]
    if negative:
        return {"valid": False, "violations": [f"{len(negative)} negative values, the first at index {negative[0]}"]}
    integers, _ = integer_scaled(values)
    total = sum(integers)
    if total == 0:
        return {"valid": False, "violations": ["the integral is zero"]}
    n = len(integers)
    value = Fraction(2 * n * autoconvolution_max(integers), total * total)
    return {"valid": True, "violations": [], "n": n, "value": value}


def circle_packing(data, count=26):
    circles = data.get("circles") if isinstance(data, dict) else None
    if not isinstance(circles, list) or len(circles) != count:
        return {"valid": False, "violations": [f"circles must be an array of exactly {count} triples"]}
    if any(not (isinstance(c, list) and len(c) == 3 and all(isinstance(v, Fraction) for v in c)) for c in circles):
        return {"valid": False, "violations": ["every circle must be a triple of numbers [x, y, r]"]}
    violations, delta = [], Fraction(0)
    for i, (x, y, r) in enumerate(circles):
        if r <= 0:
            violations.append(f"circle {i}: radius {digits(r, 20)} is not positive")
        for name, low, high in (("x", x, 1 - x), ("y", y, 1 - y)):
            if r > low or r > high:
                violations.append(f"circle {i}: it leaves the square in {name} by {digits(r - min(low, high), 6)}")
                delta = max(delta, r - min(low, high))
    for i in range(count):
        xi, yi, ri = circles[i]
        for j in range(i + 1, count):
            xj, yj, rj = circles[j]
            reach, squared = ri + rj, (xi - xj) ** 2 + (yi - yj) ** 2
            if squared < reach ** 2:
                violations.append(f"circles {i} and {j} overlap: squared-distance shortfall {digits(reach ** 2 - squared, 6)}")
                delta = max(delta, (reach ** 2 - squared) / (2 * reach))
    total = sum(r for _, _, r in circles)
    certified = None if any(r - delta <= 0 for _, _, r in circles) else total - count * delta
    return {"valid": not violations, "violations": violations, "n": count, "value": total, "shrink": delta, "certified": certified}


PROBLEMS = {"first-autocorrelation": (first_autocorrelation, "minimize"), "circle-packing": (circle_packing, "maximize")}


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("problem", choices=sorted(PROBLEMS))
    parser.add_argument("construction")
    parser.add_argument("--bound", help="the bound to beat, as the decimal it is published as")
    args = parser.parse_args(argv)
    check, direction = PROBLEMS[args.problem]
    bound = Fraction(args.bound) if args.bound is not None else None
    out = {"problem": args.problem, "direction": direction, "bound": args.bound, "readings": {}}
    for reading, data in readings(args.construction).items():
        result = check(data)
        row = {"valid": result["valid"], "violations": result["violations"][:20], "violationCount": len(result["violations"])}
        if "value" in result:
            row["value"] = digits(result["value"])
        if "certified" in result:
            row["shrink"] = digits(result["shrink"], 20)
            row["certifiedValue"] = None if result["certified"] is None else digits(result["certified"])
        # The value the bound is judged on is exactly feasible: the value itself, or the certified shrink of it.
        judged = result.get("certified") if "certified" in result else (result["value"] if result["valid"] else None)
        if bound is not None and judged is not None:
            margin = bound - judged if direction == "minimize" else judged - bound
            row["beatsBound"] = margin > 0
            row["margin"] = digits(margin, 20)
        out["readings"][reading] = row
    print(json.dumps(out, indent=1))
    return 0 if all(row["valid"] or row.get("certifiedValue") for row in out["readings"].values()) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
