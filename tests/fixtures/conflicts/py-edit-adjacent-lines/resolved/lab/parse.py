def parse(line):
    parts = line.split(",")
    name = parts[0].strip()
    age = int(parts[1] or 0)
    return {"name": name, "age": age}
