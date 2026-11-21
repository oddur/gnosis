import os


def targets(names):
    if names:
        names.sort(reverse=True)
    names.append(os.sep + "x")
    return names


def other():
    return os.sep
