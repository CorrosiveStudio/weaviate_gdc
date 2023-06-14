import {
  ComparisonValue,
  Expression,
  Field,
  Query,
  QueryRequest,
  QueryResponse,
  ScalarValue,
} from "@hasura/dc-api-types";
import { Config } from "../config";
import { WhereFilter } from "weaviate-ts-client";
import { getWeaviateClient } from "../weaviate";
import { builtInPropertiesKeys } from "./schema";

export async function executeQuery(
  query: QueryRequest,
  config: Config
): Promise<QueryResponse> {
  if (query.type !== "table") {
    throw new Error("Only table requests are supported");
  }

  // handle requests by primary key
  if (
    query.query.where?.type === "binary_op" &&
    query.query.where.operator === "equal" &&
    query.query.where.column.name === "id" &&
    query.query.where.value.type === "scalar"
  ) {
    return executeQueryById(
      query.query.where.value.value,
      query.table[0],
      query.query,
      config
    );
  }

  if (query.foreach) {
    const queries = query.foreach.map((foreach) => {
      // todo: build where filter as a map of columns and values
      const where: WhereFilter = {
        operator: "And",
        operands: Object.entries(foreach).map(([column, value]) => ({
          operator: "Equal",
          path: [column],
          ...expressionScalarValue(value),
        })),
      };
      return executeSingleQuery(where, query.table[0], query.query, config);
    });

    return Promise.all(queries).then((results) => ({
      rows: results.map((query) => ({ query })),
    }));
  } else {
    return executeSingleQuery(null, query.table[0], query.query, config);
  }
}

async function executeQueryById(
  id: string,
  table: string,
  query: Query,
  config: Config
) {
  const getter = await getWeaviateClient(config)
    .data.getterById()
    .withClassName(table)
    .withId(id);

  if (query.fields && "vector" in query.fields) {
    getter.withVector();
  }

  const response = await getter.do();

  return {
    rows: [
      Object.fromEntries(
        Object.entries(query.fields!).map(([alias, field]) => {
          if (field.type === "column") {
            if (builtInPropertiesKeys.includes(field.column)) {
              return [alias, response[field.column as keyof typeof response]];
            } else {
              return [
                alias,
                response.properties![
                  field.column as keyof typeof response.properties
                ],
              ];
            }
          } else if (field.type === "array" && field.field.type === "column") {
            if (builtInPropertiesKeys.includes(field.field.column)) {
              return [
                alias,
                response[field.field.column as keyof typeof response],
              ];
            } else {
              return [
                alias,
                response.properties![
                  field.field.column as keyof typeof response.properties
                ],
              ];
            }
          }
          throw new Error(`field of type ${field.type} not supported`);
        })
      ) as Record<string, QueryResponse>, // assertion not safe, but necessary. I hate typescript
    ],
  };
}

async function executeSingleQuery(
  forEachWhere: WhereFilter | null,
  table: string,
  query: Query,
  config: Config
) {
  const getter = getWeaviateClient(config).graphql.get();

  getter.withClassName(table);

  if (query.fields) {
    // const additionalFields = query.query.fields.filter()
    // todo: filter out additional properties into the _additional field.
    const fieldsString = queryFieldsAsString(query.fields);
    getter.withFields(fieldsString);
  }

  if (query.limit) {
    getter.withLimit(query.limit);
  }

  if (query.offset) {
    getter.withOffset(query.offset);
  }

  if (
    query.where?.type === "binary_op" &&
    query.where.operator === "near_text" &&
    query.where.value.type === "scalar"
  ) {
    getter.withNearText({
      concepts: query.where.value.value,
    });
  } else if (forEachWhere) {
    if (query.where) {
      const where = queryWhereOperator(query.where);

      getter.withWhere({
        operator: "And",
        operands: [where, forEachWhere],
      });
    } else {
      getter.withWhere(forEachWhere);
    }
  } else if (query.where) {
    getter.withWhere(queryWhereOperator(query.where));
  }

  const response = await getter.do();

  const rows = response.data.Get[table].map((row: any) =>
    Object.fromEntries(
      Object.entries(query.fields!).map(([alias, field]) => {
        if (
          field.type === "column" &&
          builtInPropertiesKeys.includes(field.column)
        ) {
          const value =
            row[alias as keyof typeof row][field.column as keyof typeof row];
          return [alias, value];
        }
        if (
          field.type === "array" &&
          field.field.type === "column" &&
          builtInPropertiesKeys.includes(field.field.column)
        ) {
          const value =
            row[alias as keyof typeof row][
              field.field.column as keyof typeof row
            ];
          return [alias, value];
        }
        if (
          field.type === "relationship" &&
          builtInPropertiesKeys.includes(field.relationship)
        ) {
          const value =
            row[alias as keyof typeof row][
              field.relationship as keyof typeof row
            ];
          return [alias, value];
        }
        const value = row[alias as keyof typeof row];
        return [alias, value];
      })
    )
  );

  return { rows };
}

export function queryWhereOperator(
  expression: Expression,
  path: string[] = [],
  negated = false
): WhereFilter {
  switch (expression.type) {
    case "not":
      return queryWhereOperator(expression.expression, path, !negated);
    case "and":
      return {
        operator: "And",
        operands: expression.expressions.map((expression) =>
          queryWhereOperator(expression, path, negated)
        ),
      };
    case "or":
      return {
        operator: "Or",
        operands: expression.expressions.map((expression) =>
          queryWhereOperator(expression, path, negated)
        ),
      };
    case "binary_op":
      switch (expression.operator) {
        case "equal":
          return {
            operator: negated ? "NotEqual" : "Equal",
            path: [...path, expression.column.name],
            ...expressionValue(expression.value),
          };
        case "less_than":
          return {
            operator: negated ? "GreaterThanEqual" : "LessThan",
            path: [...path, expression.column.name],
            ...expressionValue(expression.value),
          };
        case "less_than_or_equal":
          return {
            operator: negated ? "GreaterThan" : "LessThanEqual",
            path: [...path, expression.column.name],
            ...expressionValue(expression.value),
          };
        case "greater_than":
          return {
            operator: negated ? "LessThanEqual" : "GreaterThan",
            path: [...path, expression.column.name],
            ...expressionValue(expression.value),
          };
        case "greater_than_or_equal":
          return {
            operator: negated ? "LessThan" : "GreaterThanEqual",
            path: [...path, expression.column.name],
            ...expressionValue(expression.value),
          };
        case "near_text":
          throw new Error(
            `near_text operator not supported with other operators.`
          );
        default:
          throw new Error(
            `Unsupported binary comparison operator: ${expression.operator}`
          );
      }
    case "unary_op":
      switch (expression.operator) {
        case "is_null":
          return {
            operator: "IsNull",
            path: [...path, expression.column.name],
          };
        default:
          throw new Error(
            `Unsupported unary comparison operator: ${expression.operator}`
          );
      }
    case "binary_arr_op":
      switch (expression.operator) {
        case "in":
          return {
            operator: "Or",
            operands: expression.values.map((value) => ({
              operator: "Equal",
              path: [...path, expression.column.name],
              ...expressionValue(value),
            })),
          };
        default:
          throw new Error(
            `Unsupported binary array comparison operator: ${expression.operator}`
          );
      }
    default:
      throw new Error(`Unsupported expression type: ${expression.type}`);
  }
}

function expressionValue(value: ComparisonValue) {
  switch (value.type) {
    case "scalar":
      switch (value.value_type) {
        case "text":
          return { valueText: value.value };
        case "int":
          return { valueInt: value.value };
        case "boolean":
          return { valueBoolean: value.value };
        case "number":
          return { valueNumber: value.value };
        case "date":
          return { valueDate: value.value };
        case "uuid":
          return { valueText: value.value };
        case "geoCoordinates":
          return { valueText: value.value };
        case "phoneNumber":
          return { valueText: value.value };
        case "blob":
          return { valueText: value.value };
        default:
          throw new Error(`Unknown scalar type: ${value.value_type}`);
      }
    case "column":
      throw new Error("Column comparison not implemented");
  }
}

function expressionScalarValue(value: ScalarValue) {
  switch (value.value_type) {
    case "text":
      return { valueText: value.value };
    case "int":
      return { valueInt: value.value };
    case "boolean":
      return { valueBoolean: value.value };
    case "number":
      return { valueNumber: value.value };
    case "date":
      return { valueDate: value.value };
    case "uuid":
      return { valueText: value.value };
    case "geoCoordinates":
      return { valueText: value.value };
    case "phoneNumber":
      return { valueText: value.value };
    case "blob":
      return { valueText: value.value };
    default:
      throw new Error(`Unknown scalar type: ${value.value_type}`);
  }
}

function queryFieldsAsString(fields: Record<string, Field>): string {
  return Object.entries(fields)
    .map(([alias, field]) => {
      return `${alias}: ${fieldString(field)}`;
    })
    .join(" ");
}

// given a field, returns the graphql string for that field
// does not return the alias
// note we currently don't handle built-in objects or relationships.
function fieldString(field: Field): string {
  switch (field.type) {
    case "object":
      return `${field.column} { ${queryFieldsAsString(field.query.fields!)} }`;
    case "relationship":
      return field.relationship;
    case "column":
      if (builtInPropertiesKeys.includes(field.column)) {
        return `_additional { ${field.column} }`;
      }
      return field.column;
    case "array":
      return fieldString(field.field);
  }
}