package lab

import "strings"

func Split(s string) []string {
	return strings.Split(s, ",")
}

func ParsePairs(input string) map[string]string {
	pairs := map[string]string{}
	for _, part := range strings.Split(input, ",") {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		pairs[Trim(key)] = Trim(value)
	}
	return pairs
}
