package config

func LoadFile(path string) (Config, error) {
	return read(path)
}
