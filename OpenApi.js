/* exported getOpenApiSpec */
/* global getDeployedWebAppUrl, FIXED_FIELDS_SPEC, NUTRIENTS_SPEC, METRICS_SPEC, GOALS_SPEC, ACTIVITY_SPEC */
function getOpenApiSpec() {
  const baseUrl = getDeployedWebAppUrl();


  const logItemSchema = {
    type: "object",
    ...buildPropertiesSchemaForLog(),
    description: "Represents a single log entry for tracking nutritional data."
  };

  const batchSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { $ref: "#/components/schemas/LogItem" },
        description: "An array of LogItem objects for batch operations."
      }
    },
    required: ["items"],
    description: "An object containing an array of LogItem objects for batch operations."
  };

  const activityItemSchema = {
    type: "object",
    properties: buildPropertiesSchema(ACTIVITY_SPEC),
    required: getRequiredFields(ACTIVITY_SPEC),
    description: "Represents a source-aware activity entry. Use positive TotalKcal and CarbGrams values."
  };

  const activityBatchSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { $ref: "#/components/schemas/ActivityItem" },
        description: "An array of ActivityItem objects for batch upserts."
      }
    },
    required: ["items"],
    description: "Batch activity upsert payload."
  };

  // Reusable endpoint details
  const getLogsDocs = {
    get: {
      operationId: "logs",
      summary: "Fetch logs",
      description: "Fetch log entries from the API. Use optional query parameters to filter by ID or date.",
      parameters: [
        {
          name: "id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter logs by this ID."
        },
        {
          name: "date",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Filter logs by this date in YYYY-MM-DD format."
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", default: 50 },
          description: "Maximum number of items to return (default 50)."
        },
        {
          name: "offset",
          in: "query",
          required: false,
          schema: { type: "integer", default: 0 },
          description: "Number of items to skip before starting to return results (default 0)."
        }
      ],
      responses: {
        "200": {
          description: "Successful response with logs matching the criteria.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/LogItem" }
                  },
                  total: { type: "integer", description: "Total number of items available." },
                  limit: { type: "integer", description: "Limit applied to the result set." },
                  offset: { type: "integer", description: "Offset applied to the result set." }
                }
              }
            }
          }
        }
      }
    }
  };

  const postLogDocs = {
    post: {
      operationId: "postLog",
      summary: "Log a new entry",
      description: "Log a new entry to the API.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LogItem" }
          }
        }
      },
      responses: {
        "201": {
          description: "Log entry created successfully."
        }
      }
    },
    put: {
      operationId: "putLog",
      summary: "Update an existing log entry",
      description: "Update an existing entry in the API.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LogItem" }
          }
        }
      },
      responses: {
        "200": {
          description: "Log entry updated successfully."
        },
        "404": {
          description: "Log entry not found."
        }
      }
    },
    delete: {
      operationId: "deleteLog",
      summary: "Delete an existing log entry",
      description: "Delete an existing entry in the API.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                ID: {
                  type: "string",
                  description: "The ID of the log entry to delete."
                }
              },
              required: ["ID"]
            }
          }
        }
      },
      responses: {
        "200": {
          description: "Log entry deleted successfully."
        },
        "404": {
          description: "Log entry not found."
        }
      }
    }
  };

  const postLogsDocs = {
    post: {
      operationId: "postLogs",
      summary: "Log multiple entries",
      description: "Log multiple entries to the API.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Batch" }
          }
        }
      },
      responses: {
        "201": {
          description: "Log entries created successfully."
        }
      }
    }
  };

  const activitiesDocs = {
    get: {
      operationId: "getActivities",
      summary: "Fetch activities",
      description: "Fetch source-aware activities. Filter by date, date range, or review status.",
      parameters: [
        {
          name: "date",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Filter activities to this date in YYYY-MM-DD format."
        },
        {
          name: "start_date",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Filter activities starting from this date."
        },
        {
          name: "end_date",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Filter activities through this date."
        },
        {
          name: "review",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter activities by Review value, e.g. ok, legacy_only, source_matched, needs_review, duplicate, ignore."
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", default: 50 },
          description: "Maximum number of items to return."
        },
        {
          name: "offset",
          in: "query",
          required: false,
          schema: { type: "integer", default: 0 },
          description: "Number of items to skip."
        }
      ],
      responses: {
        "200": {
          description: "Successful response with activities.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ActivityItem" }
                  },
                  total: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" }
                }
              }
            }
          }
        }
      }
    },
    post: {
      operationId: "postActivity",
      summary: "Log or upsert an activity",
      description: "Create or update one activity. Supply ActivityKey, or Source plus SourceID. Use positive TotalKcal and CarbGrams. To delete through POST, send action='delete' plus ActivityKey.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [
                { $ref: "#/components/schemas/ActivityItem" },
                { $ref: "#/components/schemas/ActivityBatch" }
              ]
            }
          }
        }
      },
      responses: {
        "200": { description: "Activity updated or batch processed." },
        "201": { description: "Activity created." }
      }
    },
    delete: {
      operationId: "deleteActivity",
      summary: "Delete an activity",
      description: "Delete an activity by ActivityKey. Cloudflare will forward this as POST with method=DELETE.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                ActivityKey: { type: "string" }
              },
              required: ["ActivityKey"]
            }
          }
        }
      },
      responses: {
        "200": { description: "Activity deleted or not found." }
      }
    }
  };

  const settingsDocs = {
    get: {
      operationId: "getSettings",
      summary: "Fetch nutrition settings",
      description: "Fetch all nutrition settings, or one setting by key.",
      parameters: [
        {
          name: "key",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Optional setting key to fetch."
        }
      ],
      responses: {
        "200": {
          description: "Settings response.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/SettingItem" }
                  }
                }
              }
            }
          }
        }
      }
    },
    post: {
      operationId: "updateSettings",
      summary: "Create or update nutrition settings",
      description: "Create or update one setting with Key/Value, or multiple settings with {settings:{key:value}}.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [
                { $ref: "#/components/schemas/SettingItem" },
                {
                  type: "object",
                  properties: {
                    settings: {
                      type: "object",
                      additionalProperties: true
                    }
                  },
                  required: ["settings"]
                }
              ]
            }
          }
        }
      },
      responses: {
        "200": { description: "Settings updated." }
      }
    },
    delete: {
      operationId: "deleteSetting",
      summary: "Delete a nutrition setting",
      description: "Delete one setting by Key. Usually prefer update over delete for defaults.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                Key: { type: "string" }
              },
              required: ["Key"]
            }
          }
        }
      },
      responses: {
        "200": { description: "Setting deleted or not found." }
      }
    }
  };



  return {
    openapi: "3.1.0",
    info: {
      title: "Nutrition Tracker API",
      version: "1.2.1",
      description: "API for tracking nutritional data and strength workouts. Unless otherwise stated, all weight values are expressed in pounds (lb)."
    },
    servers: [
      {
        url: baseUrl,
        description: "Deployed server"
      }
    ],
    components: {
      schemas: {
        LogItem: logItemSchema,
        Batch: batchSchema,
        ActivityItem: activityItemSchema,
        ActivityBatch: activityBatchSchema,
        SettingItem: {
          type: "object",
          properties: {
            Key: { type: "string" },
            Value: {},
            Description: { type: "string" },
            UpdatedAt: { type: "string" }
          },
          required: ["Key", "Value"],
          description: "A nutrition setting. Important keys include activity_credit_mode and activity_credit_rate."
        },
        SummaryItem: {
          type: "object",
          properties: {
            Date: { type: "string", format: "date", description: "Summary date (YYYY-MM-DD)" },
            gross_kcal: { type: "number", description: "Gross calories consumed" },
            adjusted_kcal: { type: "number", description: "Adjusted calories (subtracting only carb burn)" },
            net_kcal: { type: "number", description: "Net calories (after exercise/calorie burn)" },
            total_protein: { type: "number", description: "Total protein (grams)" },
            total_fat: { type: "number", description: "Total fat (grams)" },
            gross_carbs: { type: "number", description: "Gross carbohydrates (grams)" },
            net_carbs: { type: "number", description: "Net carbohydrates (grams)" },
            total_added_sugar: { type: "number", description: "Total added sugar (grams)" },
            total_fiber: { type: "number", description: "Total fiber (grams)" },
            total_alcohol: { type: "number", description: "Total alcohol (grams)" },
            kcal_burned: { type: "number", description: "Calories burned (exercise)" },
            carbs_burned: { type: "number", description: "Carbohydrates burned (grams)" }
          },
          required: [
            "Date",
            "gross_kcal",
            "adjusted_kcal",
            "net_kcal",
            "total_protein",
            "total_fat",
            "gross_carbs",
            "net_carbs",
            "total_added_sugar",
            "total_fiber",
            "total_alcohol",
            "kcal_burned",
            "carbs_burned"
          ],
          description: "Represents a daily nutrition summary with calories, macros, and burn data."
        },
        MetricsItem: {
          type: "object",
          ...buildPropertiesSchemaForMetrics(),
          description: "Represents a single metrics entry."
        },
        GoalsItem: {
          type: "object",
          ...buildPropertiesSchemaForGoals(),
          description: "Represents a single goals entry."
        },
        StrengthWorkoutSummary: {
          type: "object",
          properties: {
            ID: { type: "integer" },
            Date: { type: "string", format: "date" },
            TemplateName: { type: "string" },
            TrainingTime: { type: "integer" },
            Calories: { type: "integer" },
            TotalCapacity: { type: "number" },
            MaxWeight: { type: "integer", description: "Maximum weight used across sets (lb)" },
            AvgWeight: { type: "integer", description: "Average weight across sets (lb)" },
            weightUnit: { type: "string", enum: ["lb"], description: "Unit for all weight fields (always 'lb')" },
            FinishActionCount: { type: "integer" },
            EndTimestamp: { type: "integer" }
          },
          description: "Compact strength workout summary. All weight values are in pounds (lb); see 'weightUnit'."
        },
        StrengthSet: {
          type: "object",
          properties: {
            WorkoutID: { type: "integer" },
            ExerciseInstanceID: { type: "integer" },
            ActionLibraryId: { type: "integer" },
            ExerciseName: { type: "string" },
            SetIndex: { type: "integer" },
            LeftRight: { type: "integer" },
            TargetCount: { type: "integer" },
            FinishedCount: { type: "integer" },
            Time: { type: "integer" },
            Capacity: { type: "number" },
            AvgWeight: { type: "integer", description: "Average weight for this set (lb)" },
            MaxWeight: { type: "integer", description: "Max weight for this set (lb)" },
            MinWeight: { type: "integer", description: "Min weight for this set (lb)" },
            weightUnit: { type: "string", enum: ["lb"], description: "Unit for all weight fields (always 'lb')" },
            WeightDetail: { type: "string", description: "Provider-specific serialized detail; weight values inside are in lb" },
            StartTime: { type: "string" },
            EndTime: { type: "string" },
            startTimestamp: { type: "integer" },
            endTimestamp: { type: "integer" },
            Calorie: { type: "integer" },
            TotalCapacity: { type: "number" },
            TrainingPartId2: { type: "integer" },
            CategoryId: { type: "integer" },
            Img: { type: "string" },
            CompletionMethod: { type: "integer" },
            SelectCompletionMethod: { type: "integer" },
            FinishGroupCount: { type: "integer" },
            IsFinish: { type: "integer" }
          },
          description: "A single performed set from a strength workout. All weight values are in pounds (lb); see 'weightUnit'."
        },
        StrengthSetFilter: {
          type: "object",
          properties: {
            daysBack: { type: "integer", description: "How many days back to include (default 7)" },
            focus: { type: "string", description: "Comma-separated list of body part columns. Valid values: quads, hamstrings, glutes, chest, back, shoulders, arms, core, calves. Matches if any column is 1." },
            movement: { type: "string", description: "Partial, case-insensitive match against Movement Type. Valid values: Squat (bilateral), Squat (unilateral), Hinge, Push (horizontal), Push (vertical), Pull (horizontal), Pull (vertical), Core (flexion), Core (extension), Core (rotation), Core (anti-rotation), Core (isometric), Isolation, Mobility, Stretch." },
            exercise: { type: "string", description: "Partial, case-insensitive match against ExerciseName." }
          },
          description: "Filter object for strength set queries. See README or external docs for full field reference."
        },
        StrengthExercise: {
          type: "object",
          properties: {
            id: { type: "integer" },
            actionLibraryId: { type: "integer" },
            actionLibraryName: { type: "string" },
            categoryId: { type: "integer" },
            trainingPartId2: { type: "integer" },
            startTimestamp: { type: "integer" },
            endTimestamp: { type: "integer" },
            finishedReps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ix: { type: "integer" },
                  avgWeight: { type: "integer", description: "Average weight for the rep/set (lb)" },
                  finishedCount: { type: "integer" },
                  targetCount: { type: "integer" },
                  time: { type: "integer" },
                  capacity: { type: "number" },
                  leftRight: { type: "integer" },
                  isFinish: { type: "boolean" },
                  weightDetail: { type: "string" }
                }
              }
            }
          }
        },
        StrengthIngestData: {
          type: "object",
          properties: {
            id: { type: "integer" },
            templateId: { type: "integer" },
            templateName: { type: "string" },
            trainingTime: { type: "integer" },
            calorie: { type: "integer" },
            totalCapacity: { type: "number" },
            startTimestamp: { type: "integer" },
            endTimestamp: { type: "integer" },
            nowTrainingTime: { type: "integer" },
            nowCalorie: { type: "integer" },
            nowTotalCapacity: { type: "number" },
            uuid: { type: "string" },
            dataVersion: { type: "integer" },
            deviceType: { type: "integer" },
            cttActionLibraryTrainingInfoList: {
              type: "array",
              items: { $ref: "#/components/schemas/StrengthExercise" }
            }
          },
          required: ["id"]
        },
        StrengthIngestWrapper: {
          type: "object",
          properties: {
            code: { type: "integer" },
            message: { type: "string" },
            data: { $ref: "#/components/schemas/StrengthIngestData" }
          },
          required: ["data"]
        }
      }
    },
    paths: {
      "/": {
        get: {
          operationId: "getData",
          summary: "Fetch data from the API",
          description: "Use the `path` query parameter to select which data to fetch. For example, `?path=summaries` or `?path=logs`. For logs, you can also filter by `id` or `date` using `?id=<ID>` or `?date=<YYYY-MM-DD>`.",
          parameters: [
            {
              name: "path",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["summaries", "logs"] },
              description: "Specify 'summaries' to fetch summaries or 'logs' to fetch logs. If omitted, the OpenAPI spec is returned."
            },
            {
              name: "id",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "If path=logs, filter logs by this ID."
            },
            {
              name: "date",
              in: "query",
              required: false,
              schema: { type: "string", format: "date" },
              description: "If path=logs, filter logs by this date in YYYY-MM-DD format."
            }
          ],
          responses: {
            "200": {
              description: "Successful response. If no path specified, returns the OpenAPI spec. If path=summaries, returns summaries. If path=logs, returns logs."
            }
          }
        }
      },
      "/log": {
        ...postLogDocs
      },
      "/logs": {
        ...getLogsDocs,
        ...postLogsDocs
      },
      "/food": {
        ...postLogDocs
      },
      "/nutrition": {
        ...postLogDocs
      },
      "/activities": {
        ...activitiesDocs
      },
      "/activity": {
        ...activitiesDocs
      },
      "/settings": {
        ...settingsDocs
      },
      "/summaries": {
        get: {
          operationId: "summaries",
          summary: "Fetch summaries",
          description: "Fetch summary data from the API.",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Successful response with summary data.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/SummaryItem" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/today": {
        get: {
          operationId: "getTodaySummary",
          summary: "Get today’s nutrition summary",
          description: "Returns the nutrition summary for the current day only.",
          responses: {
            "200": {
              description: "Today’s summary object",
              content: {
                "application/json": {
                  schema: {
                    "$ref": "#/components/schemas/SummaryItem"
                  }
                }
              }
            },
            "404": {
              description: "No summary found for today"
            }
          }
        }
      },
      "/metrics": {
        get: {
          operationId: "getMetrics",
          summary: "Fetch metrics from the API",
          description: "Retrieve metrics data. You can filter by `start_date` and `end_date` using query parameters.",
          parameters: [
            {
              name: "start_date",
              in: "query",
              required: false,
              schema: { type: "string", format: "date" },
              description: "Filter metrics starting from this date in YYYY-MM-DD format."
            },
            {
              name: "end_date",
              in: "query",
              required: false,
              schema: { type: "string", format: "date" },
              description: "Filter metrics up to this date in YYYY-MM-DD format."
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Successful response. Returns metrics data.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/MetricsItem" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            }
          }
        },
        post: {
          operationId: "postMetrics",
          summary: "Log new metrics",
          description: "Log new metrics data. To correct a weight entry, use PUT or POST with action='upsert' and Date/Weight. To delete an incorrect weight entry, use DELETE or POST with action='delete' and Date, optionally Weight.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  ...buildPropertiesSchemaForMetrics()
                }
              }
            }
          },
          responses: {
            "201": {
              description: "Metrics logged successfully."
            }
          }
        },
        put: {
          operationId: "upsertMetric",
          summary: "Update or create a metric row",
          description: "Update the metric row for a Date, or create it if missing. Use this to correct Weight values.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  ...buildPropertiesSchemaForMetrics()
                }
              }
            }
          },
          responses: {
            "200": { description: "Metric updated or created." }
          }
        },
        delete: {
          operationId: "deleteMetric",
          summary: "Delete metric rows by date",
          description: "Delete metric rows for a Date. Include Weight to narrow deletion when multiple rows exist for the same date.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    Date: { type: "string", format: "date" },
                    Weight: { type: "number" }
                  },
                  required: ["Date"]
                }
              }
            }
          },
          responses: {
            "200": { description: "Metric rows deleted or not found." }
          }
        }
      },
      "/goals": {
        get: {
          operationId: "getGoals",
          summary: "Fetch current goals from the API",
          description: "Retrieve the most recent goals for each category.",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Successful response. Returns current goals data.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/GoalsItem" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            }
          }
        },
        post: {
          operationId: "postGoals",
          summary: "Log new goals",
          description: "Log new goals data.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  ...buildPropertiesSchemaForGoals()
                }
              }
            }
          },
          responses: {
            "201": {
              description: "Goals logged successfully."
            }
          }
        }
      },
      "/goals/history": {
        get: {
          operationId: "getGoalHistory",
          summary: "Fetch goal history from the API",
          description: "Retrieve the full history of goals.",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Successful response. Returns goal history data.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/GoalsItem" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/logStrengthWorkout": {
        post: {
          operationId: "logStrengthWorkout",
          summary: "Ingest a Speediance workout",
          description: "Upload a Speediance workout. The payload must be an object with a 'data' property containing the workout. You may also POST the raw workout data object directly (without wrapper), but only the wrapper format is documented here.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StrengthIngestWrapper" },
                example: {
                  code: 0,
                  message: "OK",
                  data: {
                    id: 12345,
                    templateId: 678,
                    templateName: "Full Body Strength",
                    startTimestamp: 1695859200,
                    endTimestamp: 1695862800,
                    cttActionLibraryTrainingInfoList: [
                      {
                        id: 1,
                        actionLibraryId: 101,
                        actionLibraryName: "Squat (bilateral)",
                        categoryId: 1,
                        finishedReps: [
                          {
                            ix: 1,
                            avgWeight: 100,
                            finishedCount: 10,
                            isFinish: true
                          }
                        ]
                      }
                    ]
                  }
                }
              }
            }
          },
          responses: {
            "201": { description: "Workout created." },
            "200": { description: "Workout updated." },
            "400": { description: "Validation error." }
          }
        }
      },
      "/strength/sets": {
        get: {
          operationId: "getStrengthSets",
          summary: "Recommended: Query strength sets by time, focus, movement, or exercise.",
          description: "Recommended endpoint for analyzing exercise history. Returns all strength set rows matching filters. Supports case-insensitive, partial matching for movementType and exercise. Focus columns use 'or' logic. See StrengthSetFilter schema for valid filter fields and values.",
          parameters: [
            {
              name: "daysBack",
              in: "query",
              required: false,
              schema: { type: "integer", default: 7 },
              description: "How many days back to include (default 7)."
            },
            {
              name: "focus",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Comma-separated list of body part columns. Valid values: quads, hamstrings, glutes, chest, back, shoulders, arms, core, calves. Matches if any column is 1."
            },
            {
              name: "movement",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Partial, case-insensitive match against Movement Type."
            },
            {
              name: "exercise",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Partial, case-insensitive match against ExerciseName."
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Paginated array of matching set rows.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/StrengthSet" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/strength/workouts": {
        get: {
          operationId: "listStrengthWorkouts",
          summary: "List strength workouts",
          parameters: [
            { name: "startDate", in: "query", required: false, schema: { type: "string", format: "date" } },
            { name: "endDate", in: "query", required: false, schema: { type: "string", format: "date" } },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Paginated array of workout summaries. All weight values in the response are in pounds (lb); see 'weightUnit' property.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/StrengthWorkoutSummary" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/strength/exercises": {
        get: {
          operationId: "listStrengthExercises",
          summary: "List distinct exercises",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Paginated array of exercises.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/StrengthExercise" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/strength/workout": {
        get: {
          operationId: "getStrengthWorkout",
          summary: "Get one workout with its sets",
          parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "Workout and paginated sets.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      workout: { $ref: "#/components/schemas/StrengthWorkoutSummary" },
                      sets: {
                        type: "object",
                        properties: {
                          items: {
                            type: "array",
                            items: { $ref: "#/components/schemas/StrengthSet" }
                          },
                          total: { type: "integer" },
                          limit: { type: "integer" },
                          offset: { type: "integer" }
                        }
                      }
                    }
                  }
                }
              }
            },
            "404": { description: "Not found" }
          }
        }
      },
      "/strength/today": {
        get: {
          operationId: "getStrengthToday",
          summary: "Workouts in the last 24 hours",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Paginated array of workouts in the last 24 hours.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/StrengthWorkoutSummary" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/strength/exerciseData": {
        get: {
          operationId: "getExerciseData",
          summary: "All set rows for an exercise",
          parameters: [
            { name: "exerciseId", in: "query", required: false, schema: { type: "string" } },
            { name: "exerciseName", in: "query", required: false, schema: { type: "string" } }
          ],
          parameters: [
            { name: "exerciseId", in: "query", required: false, schema: { type: "string" } },
            { name: "exerciseName", in: "query", required: false, schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50 },
              description: "Maximum number of items to return (default 50)."
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Number of items to skip before starting to return results (default 0)."
            }
          ],
          responses: {
            "200": {
              description: "Paginated array of set rows. All weight values in the response are in pounds (lb); see 'weightUnit' property.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/StrengthSet" }
                      },
                      total: { type: "integer", description: "Total number of items available." },
                      limit: { type: "integer", description: "Limit applied to the result set." },
                      offset: { type: "integer", description: "Offset applied to the result set." }
                    }
                  }
                }
              }
            },
            "400": { description: "Missing parameters" }
          }
        }
      }
    }
  };
}

/**
 * Dynamically build the properties schema from a specification array.
 */
function buildPropertiesSchema(spec) {
  const props = {};
  spec.forEach(field => {
    props[field.name] = { type: field.type };
    if (field.format) {
      props[field.name].format = field.format;
    }
  });
  return props;
}

/**
 * Get the required fields from a specification array.
 */
function getRequiredFields(spec) {
  return spec.filter(field => field.required).map(field => field.name);
}

/**
 * Dynamically build the properties schema for FIXED_FIELDS_SPEC and NUTRIENTS_SPEC.
 */
function buildPropertiesSchemaForLog() {
  return {
    type: "object",
    properties: buildPropertiesSchema(FIXED_FIELDS_SPEC.concat(NUTRIENTS_SPEC)),
    required: getRequiredFields(FIXED_FIELDS_SPEC.concat(NUTRIENTS_SPEC)),
    description: "Represents a single log entry for tracking nutritional data."
  };
}

// (no-op) previously had a helper to map header arrays to schema; not needed now

/**
 * Dynamically build the properties schema for METRICS_SPEC.
 */
function buildPropertiesSchemaForMetrics() {
  return {
    type: "object",
    properties: buildPropertiesSchema(METRICS_SPEC),
    required: getRequiredFields(METRICS_SPEC),
    description: "Represents a single metrics entry."
  };
}

/**
 * Dynamically build the properties schema for GOALS_SPEC.
 */
function buildPropertiesSchemaForGoals() {
  return {
    type: "object",
    properties: buildPropertiesSchema(GOALS_SPEC),
    required: getRequiredFields(GOALS_SPEC),
    description: "Represents a single goals entry."
  };
}
