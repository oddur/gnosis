import math


def clamp(value, low, high):
    return max(low, min(high, value))


def weighted_mean(values, weights):
    total = 0.0
    weight_sum = 0.0
    for value, weight in zip(values, weights):
        total += value * weight
        weight_sum += weight
    if weight_sum == 0:
        return math.nan
    return total / weight_sum


def spread(values):
    return max(values) - min(values)


def histogram(values, buckets):
    low, high = min(values), max(values)
    width = (high - low) / buckets or 1
    counts = [0] * buckets
    for value in values:
        index = min(int((value - low) / width), buckets - 1)
        counts[index] += 1
    return counts


def normalise(values):
    total = sum(values)
    if not total:
        return [0 for _ in values]
    return [value / total for value in values]
