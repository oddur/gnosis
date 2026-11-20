package config

func MustLoad(path string) Config {
	c, err := Load(path)
	if err != nil {
		panic(err)
	}
	return c
}

func Load(path string) (Config, error) {
	return read(path)
}
