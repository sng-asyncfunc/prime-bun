import {
	type ClassDeclaration,
	type FunctionDeclaration,
	type Pattern,
	type Program,
	parse,
	type VariableDeclaration,
} from "acorn";

export interface TransformedJavaScriptCell {
	code: string;
	bindingNames: string[];
	bindingRecipes: Record<string, ImportBindingRecipe>;
}

export interface ImportBindingRecipe {
	type: "import";
	specifier: string;
}

interface BindingPersistence {
	name: string;
	recipe?: ImportBindingRecipe;
}

interface SourceEdit {
	start: number;
	end: number;
	text: string;
}

function collectPatternBindings(pattern: Pattern, names: string[]): void {
	switch (pattern.type) {
		case "Identifier":
			names.push(pattern.name);
			return;
		case "ObjectPattern":
			for (const property of pattern.properties) {
				collectPatternBindings(property.type === "RestElement" ? property.argument : property.value, names);
			}
			return;
		case "ArrayPattern":
			for (const element of pattern.elements) {
				if (element) collectPatternBindings(element, names);
			}
			return;
		case "RestElement":
			collectPatternBindings(pattern.argument, names);
			return;
		case "AssignmentPattern":
			collectPatternBindings(pattern.left, names);
			return;
		case "MemberExpression":
			return;
	}
}

function declarationBindings(declaration: VariableDeclaration | FunctionDeclaration | ClassDeclaration): string[] {
	if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
		return [declaration.id.name];
	}
	const names: string[] = [];
	for (const declarator of declaration.declarations) {
		collectPatternBindings(declarator.id, names);
	}
	return names;
}

function literalImportRecipe(declaration: VariableDeclaration): Record<string, ImportBindingRecipe> {
	const recipes: Record<string, ImportBindingRecipe> = {};
	for (const declarator of declaration.declarations) {
		if (declarator.id.type !== "Identifier" || declarator.init?.type !== "AwaitExpression") continue;
		const imported = declarator.init.argument;
		if (imported.type !== "ImportExpression" || imported.source.type !== "Literal") continue;
		if (typeof imported.source.value !== "string") continue;
		recipes[declarator.id.name] = { type: "import", specifier: imported.source.value };
	}
	return recipes;
}

function persistenceSource(bindings: readonly BindingPersistence[]): string {
	return bindings
		.map(({ name, recipe }) => {
			const serializedRecipe = recipe ? `, ${JSON.stringify(recipe)}` : "";
			return `\n__primePersist(${JSON.stringify(name)}, ${name}${serializedRecipe});`;
		})
		.join("");
}

function applyEdits(source: string, edits: SourceEdit[]): string {
	let transformed = source;
	for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
		transformed = `${transformed.slice(0, edit.start)}${edit.text}${transformed.slice(edit.end)}`;
	}
	return transformed;
}

function parseCell(source: string): Program {
	return parse(source, {
		allowAwaitOutsideFunction: true,
		ecmaVersion: "latest",
		sourceType: "module",
	});
}

export function transformJavaScriptCell(source: string): TransformedJavaScriptCell {
	const program = parseCell(source);
	const edits: SourceEdit[] = [];
	const bindingNames: string[] = [];
	const bindingRecipes: Record<string, ImportBindingRecipe> = {};
	const persistedBindings: BindingPersistence[] = [];

	for (const statement of program.body) {
		switch (statement.type) {
			case "ImportDeclaration":
				throw new SyntaxError("Static imports are not supported in Bun cells; use await import() or require().");
			case "ExportNamedDeclaration":
			case "ExportDefaultDeclaration":
			case "ExportAllDeclaration":
				throw new SyntaxError("Exports are not supported in Bun cells.");
			case "VariableDeclaration":
			case "FunctionDeclaration":
			case "ClassDeclaration": {
				const names = declarationBindings(statement);
				const recipes = statement.type === "VariableDeclaration" ? literalImportRecipe(statement) : {};
				bindingNames.push(...names);
				Object.assign(bindingRecipes, recipes);
				const statementBindings = names.map((name) => ({ name, recipe: recipes[name] }));
				persistedBindings.push(...statementBindings);
				edits.push({ start: statement.end, end: statement.end, text: persistenceSource(statementBindings) });
				break;
			}
		}
	}

	const finalStatement = program.body.at(-1);
	if (finalStatement?.type === "ExpressionStatement") {
		const expression = source.slice(finalStatement.expression.start, finalStatement.expression.end);
		const finalPersistence = persistenceSource(persistedBindings);
		edits.push({
			start: finalStatement.start,
			end: finalStatement.end,
			text: finalPersistence
				? `try {\nreturn (${expression});\n} finally {${finalPersistence}\n}`
				: `return (${expression});`,
		});
	} else if (bindingNames.length > 0) {
		edits.push({ start: source.length, end: source.length, text: persistenceSource(persistedBindings) });
	}

	return {
		code: applyEdits(source, edits),
		bindingNames,
		bindingRecipes,
	};
}
