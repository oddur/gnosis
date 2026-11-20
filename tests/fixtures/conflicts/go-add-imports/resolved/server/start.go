package server

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

func Start(addr string) error {
	fmt.Println("listening on", addr, os.Getpid())
	srv := &http.Server{Addr: addr, ReadTimeout: 5 * time.Second}
	return srv.ListenAndServe()
}
