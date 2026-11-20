package config

func Load(path string) (Config, error) {
	return read(path)
}
