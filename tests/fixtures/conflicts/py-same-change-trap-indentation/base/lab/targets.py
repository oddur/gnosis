import os


def targets(names):
    if names:
        names.sort()
    names.append(os.sep)
    return names


def other():
    return os.sep
