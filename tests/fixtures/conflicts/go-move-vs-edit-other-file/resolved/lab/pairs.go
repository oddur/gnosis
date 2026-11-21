package lab

import (
	"sort"
	"strings"
)

func Trim(s string) string {
	return strings.TrimSpace(s)
}

func Join(parts []string) string {
	return strings.Join(parts, ",")
}

func Keys(pairs map[string]string) []string {
	keys := make([]string, 0, len(pairs))
	for key := range pairs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func Format(pairs map[string]string) string {
	var b strings.Builder
	for i, key := range Keys(pairs) {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(key + "=" + pairs[key])
	}
	return b.String()
}
