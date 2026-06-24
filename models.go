package main

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"sync"
)

// ansiRe matches ANSI/VT escape sequences emitted by PTY-attached processes.
var ansiRe = regexp.MustCompile(`\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`)

type Shortcut struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	CommandIDs []string `json:"commandIds"`
}

type Project struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	WorkingDir string            `json:"workingDir"`
	Groups     []string          `json:"groups"`
	GroupPaths map[string]string `json:"groupPaths,omitempty"`
	Commands   []CommandConfig   `json:"commands"`
	Shortcuts  []Shortcut        `json:"shortcuts,omitempty"`
}

type PostCommand struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"` // seconds; 0 = default (120)
}

type CommandConfig struct {
	ID           string        `json:"id"`
	Label        string        `json:"label"`
	Command      string        `json:"command"`
	Group        string        `json:"group"`
	WorkingDir   string        `json:"workingDir,omitempty"`
	Interactive  bool          `json:"interactive,omitempty"`
	PreCommands  []string      `json:"preCommands,omitempty"`
	PostCommands []PostCommand `json:"postCommands,omitempty"`
}

type CommandResult struct {
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

type ProcessStats struct {
	CmdID string  `json:"cmdId"`
	Label string  `json:"label"`
	RSS   int64   `json:"rss"`
	CPU   float64 `json:"cpu"`
}

type ResourceStats struct {
	AppRSS      int64          `json:"appRss"`
	AppCPU      float64        `json:"appCpu"`
	TotalCmdRSS int64          `json:"totalCmdRss"`
	TotalCmdCPU float64        `json:"totalCmdCpu"`
	Commands    []ProcessStats `json:"commands"`
}

type App struct {
	ctx         context.Context
	ctxMu       sync.RWMutex
	processes   map[string]*exec.Cmd
	processesMu sync.RWMutex
	ptmxWriters map[string]*os.File
	ptmxMu      sync.RWMutex
	cmdLabels   map[string]string
	cmdLabelsMu sync.RWMutex
}
