package server

import (
	"fmt"
	"net/http"
	"os"
)

func Start(addr string) error {
	fmt.Println("listening on", addr, os.Getpid())
	return http.ListenAndServe(addr, nil)
}
