package main

// Type aliases re-export internal/models types under package main so that
// Wails generates TypeScript bindings in the "main" namespace, keeping the
// frontend unchanged after the backend package restructure.
import models "yv/internal/models"

type (
	Shortcut      = models.Shortcut
	Project       = models.Project
	PostCommand   = models.PostCommand
	CommandConfig = models.CommandConfig
	CommandResult = models.CommandResult
	ProcessStats  = models.ProcessStats
	ResourceStats = models.ResourceStats
	EnvVar        = models.EnvVar
	Environment   = models.Environment
	ProjectEnvs   = models.ProjectEnvs
)
