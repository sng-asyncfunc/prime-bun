import {
	type ClassDeclaration,
	type FunctionDeclaration,
	type ImportDeclaration,
	type Pattern,
	type Program,
	parse,
	type VariableDeclaration,
} from "acorn";

export interface TransformedJavaScriptCell {
	code: string;
	bindingNames: string[];
	bindingRecipes: Record<string, ModuleBindingRecipe>;
}

export interface ModuleBindingRecipe {
	type: "module";
	loader: "import" | "require";
	specifier: string;
	exportName?: string;
}

interface BindingPersistence {
	name: string;
	recipe?: ModuleBindingRecipe;
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

function literalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function objectPatternBinding(pattern: Pattern): string | undefined {
	if (pattern.type === "Identifier") return pattern.name;
	if (pattern.type === "AssignmentPattern" && pattern.left.type === "Identifier") return pattern.left.name;
	return undefined;
}

function recordObjectPatternRecipes(
	pattern: Extract<Pattern, { type: "ObjectPattern" }>,
	loader: ModuleBindingRecipe["loader"],
	specifier: string,
	recipes: Record<string, ModuleBindingRecipe>,
): void {
	for (const property of pattern.properties) {
		if (property.type === "RestElement" || property.computed) continue;
		const exportName =
			property.key.type === "Identifier"
				? property.key.name
				: property.key.type === "Literal"
					? literalString(property.key.value)
					: undefined;
		const localName = objectPatternBinding(property.value);
		if (!exportName || !localName) continue;
		recipes[localName] = { exportName, loader, specifier, type: "module" };
	}
}

function literalModuleRecipes(declaration: VariableDeclaration): Record<string, ModuleBindingRecipe> {
	const recipes: Record<string, ModuleBindingRecipe> = {};
	for (const declarator of declaration.declarations) {
		const initializer = declarator.init;
		if (!initializer) continue;
		if (initializer.type === "AwaitExpression" && initializer.argument.type === "ImportExpression") {
			const specifier =
				initializer.argument.source.type === "Literal"
					? literalString(initializer.argument.source.value)
					: undefined;
			if (!specifier) continue;
			if (declarator.id.type === "Identifier") {
				recipes[declarator.id.name] = { loader: "import", specifier, type: "module" };
				continue;
			}
			if (declarator.id.type === "ObjectPattern") {
				recordObjectPatternRecipes(declarator.id, "import", specifier, recipes);
			}
			continue;
		}
		if (
			initializer.type !== "CallExpression" ||
			initializer.callee.type !== "Identifier" ||
			initializer.callee.name !== "require" ||
			initializer.arguments.length !== 1
		) {
			continue;
		}
		const argument = initializer.arguments[0];
		if (!argument || argument.type !== "Literal") continue;
		const specifier = literalString(argument.value);
		if (!specifier) continue;
		if (declarator.id.type === "Identifier") {
			recipes[declarator.id.name] = { loader: "require", specifier, type: "module" };
		} else if (declarator.id.type === "ObjectPattern") {
			recordObjectPatternRecipes(declarator.id, "require", specifier, recipes);
		}
	}
	return recipes;
}

function importedBindingExpression(namespace: string, exportName: string, specifier: string): string {
	const key = JSON.stringify(exportName);
	const message = JSON.stringify(`Module ${specifier} does not export ${exportName}`);
	return `(${key} in ${namespace} ? ${namespace}[${key}] : (() => { throw new SyntaxError(${message}); })())`;
}

function lowerImportDeclaration(
	declaration: ImportDeclaration,
	namespace: string,
): { code: string; bindings: BindingPersistence[] } {
	const specifier = literalString(declaration.source.value);
	if (!specifier) throw new SyntaxError("Static import specifiers must be string literals.");
	if (declaration.attributes.length > 0) {
		throw new SyntaxError("Static import attributes are not supported in Bun cells.");
	}
	if (declaration.specifiers.length === 0) {
		return { code: `await import(${JSON.stringify(specifier)});`, bindings: [] };
	}

	const lines = [`const ${namespace} = await import(${JSON.stringify(specifier)});`];
	const bindings: BindingPersistence[] = [];
	for (const importSpecifier of declaration.specifiers) {
		const name = importSpecifier.local.name;
		let exportName: string | undefined;
		switch (importSpecifier.type) {
			case "ImportDefaultSpecifier":
				exportName = "default";
				break;
			case "ImportNamespaceSpecifier":
				break;
			case "ImportSpecifier":
				exportName =
					importSpecifier.imported.type === "Identifier"
						? importSpecifier.imported.name
						: literalString(importSpecifier.imported.value);
				if (!exportName) throw new SyntaxError("Static import names must be strings.");
				break;
		}
		const recipe: ModuleBindingRecipe = {
			...(exportName ? { exportName } : {}),
			loader: "import",
			specifier,
			type: "module",
		};
		lines.push(
			`const ${name} = ${exportName ? importedBindingExpression(namespace, exportName, specifier) : namespace};`,
		);
		bindings.push({ name, recipe });
	}
	return { code: lines.join("\n"), bindings };
}

function privateImportNamespace(source: string, index: number, generatedNames: Set<string>): string {
	let name = `__primeImport${index}`;
	while (source.includes(name) || generatedNames.has(name)) name += "_";
	generatedNames.add(name);
	return name;
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
	const bindingRecipes: Record<string, ModuleBindingRecipe> = {};
	const persistedBindings: BindingPersistence[] = [];
	const generatedImportNames = new Set<string>();
	let importIndex = 0;

	for (const statement of program.body) {
		switch (statement.type) {
			case "ImportDeclaration": {
				const namespace = privateImportNamespace(source, importIndex, generatedImportNames);
				const lowered = lowerImportDeclaration(statement, namespace);
				importIndex += 1;
				bindingNames.push(...lowered.bindings.map(({ name }) => name));
				for (const binding of lowered.bindings) {
					if (binding.recipe) bindingRecipes[binding.name] = binding.recipe;
				}
				persistedBindings.push(...lowered.bindings);
				edits.push({
					start: statement.start,
					end: statement.end,
					text: `${lowered.code}${persistenceSource(lowered.bindings)}`,
				});
				break;
			}
			case "ExportNamedDeclaration":
			case "ExportDefaultDeclaration":
			case "ExportAllDeclaration":
				throw new SyntaxError("Exports are not supported in Bun cells.");
			case "VariableDeclaration":
			case "FunctionDeclaration":
			case "ClassDeclaration": {
				const names = declarationBindings(statement);
				const recipes = statement.type === "VariableDeclaration" ? literalModuleRecipes(statement) : {};
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
