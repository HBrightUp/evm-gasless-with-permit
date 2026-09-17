package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"gasless-usdt-erc2771/apps/relayer/internal/relay"
	"github.com/gin-gonic/gin"
)

func main() {
	if err := run(); err != nil {
		slog.Error("relayer stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := relay.LoadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 45*time.Second)
	chain, err := relay.NewEthereum(startup, cfg)
	cancel()
	if err != nil {
		return err
	}
	defer chain.Close()
	gin.SetMode(gin.ReleaseMode)
	router, err := relay.NewRouter(cfg, chain, slog.Default())
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr: fmt.Sprintf(":%d", cfg.Port), Handler: router,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 130 * time.Second, IdleTimeout: 60 * time.Second,
	}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	slog.Info("Go/Gin relayer starting", "url", fmt.Sprintf("http://localhost:%d", cfg.Port), "account", chain.Address().Hex())
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return err
		}
	}
	return nil
}
