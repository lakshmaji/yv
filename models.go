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

	Settings           = models.Settings
	MetricsQuery       = models.MetricsQuery
	MetricsPoint       = models.MetricsPoint
	MetricsSeries      = models.MetricsSeries
	MetricsResult      = models.MetricsResult
	FrequencyPoint     = models.FrequencyPoint
	FrequencySeries    = models.FrequencySeries
	FrequencyResult    = models.FrequencyResult
	ActivityDay        = models.ActivityDay
	ActivityHeatmap    = models.ActivityHeatmap
	MetricsStorageInfo = models.MetricsStorageInfo
)
