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
        }
      ],
      responses: {
        "200": {
          description: "Successful response with logs matching the criteria.",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/LogItem" }
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

  const summariesDocs = {
    get: {
      operationId: "summaries",
      summary: "Fetch summaries",
      description: "Fetch summary data from the API.",
      responses: {
        "200": {
          description: "Successful response with summary data.",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/SummaryItem" }
              }
            }
          }
        }
      }
    }
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Nutrition Tracker API",
      version: "1.1.0",
      description: "API for tracking nutritional data."
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
      "/summaries": {
        get: {
          operationId: "summaries",
          summary: "Fetch summaries",
          description: "Fetch summary data from the API.",
          responses: {
            "200": {
              description: "Successful response with summary data.",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/SummaryItem" }
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
            }
          ],
          responses: {
            "200": {
              description: "Successful response. Returns metrics data."
            }
          }
        },
        post: {
          operationId: "postMetrics",
          summary: "Log new metrics",
          description: "Log new metrics data.",
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
        }
      },
      "/goals": {
        get: {
          operationId: "getGoals",
          summary: "Fetch current goals from the API",
          description: "Retrieve the most recent goals for each category.",
          responses: {
            "200": {
              description: "Successful response. Returns current goals data."
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
          responses: {
            "200": {
              description: "Successful response. Returns goal history data."
            }
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