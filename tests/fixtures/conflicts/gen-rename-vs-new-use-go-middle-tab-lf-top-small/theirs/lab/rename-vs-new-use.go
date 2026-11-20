package lab

func filler0(value int) int {
	return value + 0
}

func helper(value int) int {
	return alpha(value) + 1
}

func alpha(value int) int {
	total := value + 1
	scaled := total * 2
	return scaled - 3
}

func filler1(value int) int {
	return value + 1
}
