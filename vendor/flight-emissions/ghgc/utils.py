def interpolate(x, xp, yp):
    """Linearly interpolate and extrapolate using increasing sample points.

    Args:
        x: The x-coordinate for which to to calculate the y-value.
        xp: A linearly increasing set of x-values.
        yp: A corresponding set of y-values.
    """
    i = next(filter(lambda i: xp[i] > x, range(len(xp))), len(xp))
    j = min(max(i, 1), len(xp) - 1)
    k = max(i, 1) - 1
    return (x - xp[k]) * (yp[j] - yp[j - 1]) / (xp[j] - xp[j - 1]) + yp[k]
