import {
	type ClassDeclaration,
	type FunctionDeclaration,
	type ImportDeclaration,
	type ModuleDeclaration,
	type Pattern,
	type Program,
	parse,
	type ReturnStatement,
	type Statement,
	type VariableDeclaration,
} from "acorn";

export interface TransformedJavaScriptCell {
	code: string;
	bindingNames: string[];
	bindingRecipes: Record<string, ModuleBindingRecipe>;
}

export interface TransformJavaScriptCellOptions {
	runtimeGlobalNames?: ReadonlySet<string>;
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

function isRedundantRuntimeGlobalAlias(
	declaration: VariableDeclaration,
	runtimeGlobalNames: ReadonlySet<string> | undefined,
): boolean {
	if (declaration.kind !== "const" || !runtimeGlobalNames || declaration.declarations.length === 0) return false;
	return declaration.declarations.every((declarator) => {
		if (
			declarator.init?.type !== "Identifier" ||
			declarator.init.name !== "globalThis" ||
			declarator.id.type !== "ObjectPattern" ||
			declarator.id.properties.length === 0
		) {
			return false;
		}
		return declarator.id.properties.every((property) => {
			if (
				property.type === "RestElement" ||
				property.computed ||
				property.key.type !== "Identifier" ||
				property.value.type !== "Identifier"
			) {
				return false;
			}
			return property.key.name === property.value.name && runtimeGlobalNames.has(property.value.name);
		});
	});
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
		allowReturnOutsideFunction: true,
		ecmaVersion: "latest",
		sourceType: "module",
	});
}

function collectNotebookReturnStatements(statement: Statement | ModuleDeclaration, returns: ReturnStatement[]): void {
	switch (statement.type) {
		case "ReturnStatement":
			returns.push(statement);
			return;
		case "BlockStatement":
			for (const child of statement.body) collectNotebookReturnStatements(child, returns);
			return;
		case "WithStatement":
		case "LabeledStatement":
		case "WhileStatement":
		case "DoWhileStatement":
		case "ForStatement":
		case "ForInStatement":
		case "ForOfStatement":
			collectNotebookReturnStatements(statement.body, returns);
			return;
		case "IfStatement":
			collectNotebookReturnStatements(statement.consequent, returns);
			if (statement.alternate) collectNotebookReturnStatements(statement.alternate, returns);
			return;
		case "SwitchStatement":
			for (const switchCase of statement.cases) {
				for (const child of switchCase.consequent) collectNotebookReturnStatements(child, returns);
			}
			return;
		case "TryStatement":
			collectNotebookReturnStatements(statement.block, returns);
			if (statement.handler) collectNotebookReturnStatements(statement.handler.body, returns);
			if (statement.finalizer) collectNotebookReturnStatements(statement.finalizer, returns);
			return;
		case "ExpressionStatement":
		case "EmptyStatement":
		case "DebuggerStatement":
		case "BreakStatement":
		case "ContinueStatement":
		case "ThrowStatement":
		case "VariableDeclaration":
		case "FunctionDeclaration":
		case "ClassDeclaration":
		case "ImportDeclaration":
		case "ExportNamedDeclaration":
		case "ExportDefaultDeclaration":
		case "ExportAllDeclaration":
			return;
	}
}

function returnPersistenceEdit(
	source: string,
	statement: Statement | ModuleDeclaration,
	returns: readonly ReturnStatement[],
	bindings: readonly BindingPersistence[],
	index: number,
): SourceEdit {
	let namespace = `__primeReturn${index}`;
	while (source.includes(namespace)) namespace += "_";
	const didReturn = `${namespace}DidReturn`;
	const returnValue = `${namespace}Value`;
	const caughtError = `${namespace}Error`;
	const statementSource = source.slice(statement.start, statement.end);
	const returnEdits = returns.map((returnStatement): SourceEdit => {
		const argument = returnStatement.argument;
		return {
			start: returnStatement.start - statement.start,
			end: returnStatement.end - statement.start,
			text: argument
				? `return (${returnValue} = (${source.slice(argument.start, argument.end)}), ${didReturn} = true, ${returnValue});`
				: `return (${didReturn} = true, undefined);`,
		};
	});
	const transformedStatement = applyEdits(statementSource, returnEdits);
	return {
		start: statement.start,
		end: statement.end,
		text: `let ${didReturn} = false;
let ${returnValue};
try {
${transformedStatement}
${didReturn} = false;
} catch (${caughtError}) {
${didReturn} = false;
throw ${caughtError};
} finally {
if (${didReturn}) {${persistenceSource(bindings)}
}
}`,
	};
}

export function transformJavaScriptCell(
	source: string,
	options: TransformJavaScriptCellOptions = {},
): TransformedJavaScriptCell {
	const program = parseCell(source);
	const edits: SourceEdit[] = [];
	const bindingNames: string[] = [];
	const bindingRecipes: Record<string, ModuleBindingRecipe> = {};
	const persistedBindings: BindingPersistence[] = [];
	const generatedImportNames = new Set<string>();
	let importIndex = 0;
	let returnIndex = 0;

	for (const statement of program.body) {
		const returns: ReturnStatement[] = [];
		collectNotebookReturnStatements(statement, returns);
		if (returns.length > 0 && persistedBindings.length > 0) {
			edits.push(returnPersistenceEdit(source, statement, returns, persistedBindings, returnIndex));
			returnIndex += 1;
		}
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
				if (
					statement.type === "VariableDeclaration" &&
					isRedundantRuntimeGlobalAlias(statement, options.runtimeGlobalNames)
				) {
					edits.push({ start: statement.start, end: statement.end, text: "" });
					break;
				}
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
