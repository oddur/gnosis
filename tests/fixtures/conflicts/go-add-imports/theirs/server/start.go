package server

import (
	"fmt"
	"net/http"
	"time"
)

func Start(addr string) error {
	fmt.Println("listening on", addr)
	srv := &http.Server{Addr: addr, ReadTimeout: 5 * time.Second}
	return srv.ListenAndServe()
}
