import { getDirectiveValues, GraphQLIncludeDirective, GraphQLSkipDirective, Kind } from 'graphql';

// Use schema names rather than aliases. Include fragment selections and honor
// directives so a hidden optional field does not trigger database work.
export function selectedFields(info) {
  const fields = new Set();
  const walk = (selectionSet, prefix = '', visited = new Set()) => {
    for (const node of selectionSet?.selections || []) {
      if (getDirectiveValues(GraphQLSkipDirective, node, info.variableValues)?.if === true
        || getDirectiveValues(GraphQLIncludeDirective, node, info.variableValues)?.if === false) continue;
      if (node.kind === Kind.FIELD) {
        const path = prefix ? `${prefix}.${node.name.value}` : node.name.value;
        fields.add(path);
        walk(node.selectionSet, path, visited);
      } else if (node.kind === Kind.INLINE_FRAGMENT) {
        walk(node.selectionSet, prefix, visited);
      } else if (node.kind === Kind.FRAGMENT_SPREAD && !visited.has(node.name.value)) {
        const next = new Set(visited).add(node.name.value);
        walk(info.fragments[node.name.value]?.selectionSet, prefix, next);
      }
    }
  };
  for (const node of info.fieldNodes) walk(node.selectionSet);
  return fields;
}
