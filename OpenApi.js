function getOpenApiSpec() {
  const baseUrl = getDeployedWebAppUrl();

  // Define reusable schema for LogItem
  const logProperties = buildPropertiesSchema();

  const logItemSchema = {
    type: "object",
    properties: logProperties,
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
    openapi: "3.0.0",
    info: {
      title: "Nutrition Tracker API",
      version: "1.0.0",
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
          properties: buildPropertiesSchema()
        },
        MetricsItem: {
          type: "object",
          properties: buildPropertiesSchemaForMetrics(),
          description: "Represents a single metrics entry."
        },
        GoalsItem: {
          type: "object",
          properties: buildPropertiesSchemaForGoals(),
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
        ...summariesDocs
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
                  properties: buildPropertiesSchemaForMetrics()
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
                  properties: buildPropertiesSchemaForGoals()
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
 * Dynamically build the properties schema from FIXED_FIELDS_SPEC and NUTRIENTS_SPEC.
 */
function buildPropertiesSchema() {
  const props = {};
  FIXED_FIELDS_SPEC.concat(NUTRIENTS_SPEC).forEach(field => {
    props[field.name] = { type: field.type };
    if (field.format) {
      props[field.name].format = field.format;
    }
  });
  return props;
}

/**
 * Dynamically build the properties schema for METRICS_SPEC.
 */
function buildPropertiesSchemaForMetrics() {
  const props = {};
  METRICS_SPEC.forEach(field => {
    props[field.name] = { type: field.type };
    if (field.format) {
      props[field.name].format = field.format;
    }
  });
  return props;
}

/**
 * Dynamically build the properties schema for GOALS_SPEC.
 */
function buildPropertiesSchemaForGoals() {
  const props = {};
  GOALS_SPEC.forEach(field => {
    props[field.name] = { type: field.type };
    if (field.format) {
      props[field.name].format = field.format;
    }
  });
  return props;
}