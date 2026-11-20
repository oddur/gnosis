package server

import (
	"fmt"
	"net/http"
)

func Start(addr string) error {
	fmt.Println("listening on", addr)
	return http.ListenAndServe(addr, nil)
}
