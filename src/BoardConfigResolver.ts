/** Arduino board and build properties keyed by their platform property name. */
export type BoardProperties = Record<string, string>;

/** The structured components of a `menu.<type>.<option>[.<property>]` key. */
export interface BoardMenuPropertyKey {
    menuType: string;
    option: string;
    propertyKey?: string;
}

/** A resolved board configuration and its menu choices in source order. */
export interface ResolvedBoardMenus {
    boardProperties: BoardProperties;
    selectedMenus: Map<string, string>;
}

/**
 * Parses an Arduino board menu key without changing the key's case.
 *
 * The input must contain at least `menu.<type>.<option>`. Option label keys do
 * not have a property suffix and therefore return an undefined `propertyKey`.
 * Invalid or non-menu keys return undefined. The input is never modified.
 */
export function parseBoardMenuPropertyKey(key: string): BoardMenuPropertyKey | undefined {
    const match = /^menu\.([^.]+)\.([^.]+)(?:\.(.*))?$/.exec(key);
    if (!match) {
        return undefined;
    }

    return {
        menuType: match[1],
        option: match[2],
        propertyKey: match[3]
    };
}

/**
 * Selects one board from a board-prefixed property bag.
 *
 * Only keys beginning with `<boardId>.` are returned and that prefix is
 * removed. When a truthy build property explicitly selects a menu, only that
 * exact, case-sensitive option is retained. An invalid explicit option thus
 * removes every standard entry for that menu, matching the parser's existing
 * filtering behavior. Property insertion order is preserved and neither
 * input object is modified.
 */
export function selectBoardProperties(
    boardPropertiesWithBoardPrefix: Readonly<BoardProperties>,
    boardId: string,
    buildProperties: Readonly<BoardProperties> = {}
): BoardProperties {
    const boardPrefix = `${boardId}.`;
    const selected: BoardProperties = {};

    for (const [key, value] of Object.entries(boardPropertiesWithBoardPrefix)) {
        if (!key.startsWith(boardPrefix)) {
            continue;
        }

        const configKey = key.substring(boardPrefix.length);
        const menu = configKey.startsWith('menu.')
            ? parseBoardMenuPropertyKey(configKey)
            : undefined;

        if (menu && buildProperties[menu.menuType]) {
            if (menu.option === buildProperties[menu.menuType]) {
                selected[configKey] = value;
            }
            continue;
        }

        selected[configKey] = value;
    }

    return selected;
}

function collectMenuOptions(boardProperties: Readonly<BoardProperties>): Map<string, string[]> {
    const menuOptions = new Map<string, string[]>();

    for (const key of Object.keys(boardProperties)) {
        const menu = parseBoardMenuPropertyKey(key);
        if (!menu) {
            continue;
        }

        let options = menuOptions.get(menu.menuType);
        if (!options) {
            options = [];
            menuOptions.set(menu.menuType, options);
        }
        if (!options.includes(menu.option)) {
            options.push(menu.option);
        }
    }

    return menuOptions;
}

function applyMenuOption(
    target: BoardProperties,
    source: Readonly<BoardProperties>,
    menuType: string,
    option: string
): void {
    for (const [key, value] of Object.entries(source)) {
        const menu = parseBoardMenuPropertyKey(key);
        if (menu?.menuType === menuType
            && menu.option === option
            && menu.propertyKey !== undefined) {
            target[menu.propertyKey] = value;
        }
    }
}

/**
 * Resolves every menu present in a board property bag.
 *
 * Menu types and options are visited in object insertion order. A valid,
 * truthy, case-sensitive build selection wins; otherwise the first option is
 * used as Arduino's default. Selected option properties are overlaid in menu
 * order. The returned property bag is a copy and neither input is modified.
 */
export function resolveBoardMenus(
    boardProperties: Readonly<BoardProperties>,
    buildProperties: Readonly<BoardProperties> = {}
): ResolvedBoardMenus {
    const resolved = { ...boardProperties };
    const selectedMenus = new Map<string, string>();
    const menuOptions = collectMenuOptions(boardProperties);

    for (const [menuType, options] of menuOptions) {
        if (options.length === 0) {
            continue;
        }

        const requestedOption = buildProperties[menuType];
        const selectedOption = requestedOption && options.includes(requestedOption)
            ? requestedOption
            : options[0];

        selectedMenus.set(menuType, selectedOption);
        applyMenuOption(resolved, boardProperties, menuType, selectedOption);
    }

    return {
        boardProperties: resolved,
        selectedMenus
    };
}

interface PartitionScheme {
    uploadMaximumSize?: string;
    uploadExtraFlags?: string;
}

function findPartitionScheme(
    boardProperties: Readonly<BoardProperties>,
    partitionValue: string
): PartitionScheme | undefined {
    for (const [key, value] of Object.entries(boardProperties)) {
        const menu = parseBoardMenuPropertyKey(key);
        if (menu?.menuType !== 'PartitionScheme'
            || menu.propertyKey !== 'build.partitions'
            || value !== partitionValue) {
            continue;
        }

        return {
            uploadMaximumSize:
                boardProperties[`menu.PartitionScheme.${menu.option}.upload.maximum_size`],
            uploadExtraFlags:
                boardProperties[`menu.PartitionScheme.${menu.option}.upload.extra_flags`]
        };
    }

    return undefined;
}

/**
 * Applies build-time overrides to a resolved board property bag.
 *
 * Existing menu selections are applied first in menu insertion order. A
 * `build.partitions` value then maps the matching `PartitionScheme` upload
 * limits and flags, but intentionally does not replace `build.partitions`
 * itself. Remaining non-menu properties are overlaid in build-property order.
 * The returned object is a copy and neither input is modified.
 */
export function applyBoardBuildProperties(
    boardProperties: Readonly<BoardProperties>,
    buildProperties: Readonly<BoardProperties>
): BoardProperties {
    const resolved = { ...boardProperties };
    const menuOptions = collectMenuOptions(boardProperties);

    for (const menuType of menuOptions.keys()) {
        const requestedOption = buildProperties[menuType];
        if (requestedOption) {
            applyMenuOption(resolved, boardProperties, menuType, requestedOption);
        }
    }

    const partitionValue = buildProperties['build.partitions'];
    if (partitionValue) {
        const scheme = findPartitionScheme(boardProperties, partitionValue);
        if (scheme?.uploadMaximumSize) {
            resolved['upload.maximum_size'] = scheme.uploadMaximumSize;
        }
        if (scheme?.uploadExtraFlags) {
            resolved['upload.extra_flags'] = scheme.uploadExtraFlags;
        }
    }

    for (const [key, value] of Object.entries(buildProperties)) {
        if (!menuOptions.has(key) && key !== 'build.partitions') {
            resolved[key] = value;
        }
    }

    return resolved;
}

/**
 * Formats an effective Arduino FQBN from menu choices in Map insertion order.
 *
 * The base FQBN is returned unchanged when there are no selections; otherwise
 * `:<menu>=<option>` parameters are appended as one comma-separated segment.
 * The supplied Map is read only and is not modified.
 */
export function formatEffectiveFqbn(
    fqbn: string,
    selectedMenus: ReadonlyMap<string, string>
): string {
    const parameters = Array.from(
        selectedMenus,
        ([menuType, option]) => `${menuType}=${option}`
    );

    return parameters.length > 0
        ? `${fqbn}:${parameters.join(',')}`
        : fqbn;
}
