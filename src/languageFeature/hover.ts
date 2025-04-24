import {
    CancellationToken,
    commands,
    Diagnostic,
    ExtensionContext,
    Hover,
    languages,
    MarkdownString,
    Position,
    Range,
    TextDocument,
    window,
} from "vscode";
import { getConfig } from "../configuration";
import { /* client,*/  outputChannel } from "../extension";
import { ShortLive } from "../util/short-live";
import { compileBlock } from "../syntax/compile";
import { compileMarkdown, getMarkdownTextValue } from "../syntax/marked";
import { ICommentBlock } from "../interface";
import { createComment } from "../syntax/Comment";

export let shortLive = new ShortLive<string>((prev, curr) => prev === curr);
let last: Map<string, Range> = new Map();

let working: Set<String> = new Set();

async function commentProvideHover(
    document: TextDocument,
    position: Position,
    _token: CancellationToken,
    canLanguages: string[],
): Promise<Hover | null> {
    const uri = document.uri.toString();

    const concise = getConfig<boolean>("hover.concise");
    const nearShow = getConfig<boolean>("hover.nearShow");

    if (concise && !shortLive.isLive(uri)) return null;

    let block: ICommentBlock | null = selectionContains(uri, position);
    let res: { md: MarkdownString, header: MarkdownString } | undefined;
    let range: Range | undefined;

    if (!block) {
        if (document.languageId === "markdown") {
            if (document.languageId !== "markdown") return null;
            let { translatedText, range: MarkdwonRange } = await compileMarkdown(document, position);
            res = createHoverMarkdownString(
                translatedText,
                '',
                uri,
                MarkdwonRange,
                document,
                ''
            );
            range = MarkdwonRange;
        } else if (canLanguages.includes(document.languageId)) {
            try {
                let comment = await createComment();
                block = await comment.getComment(document, position);
            } catch (e) {
                //@ts-ignore
                outputChannel.append("\n" + e.message);
            }

            if (!block) {
                return null;
            }
        }
    }


    if (block) {
        const translatedBlock = await compileBlock(block, document.languageId);
        const { translatedText, translateLink, humanizeText } = translatedBlock;
        range = block.range;
        res = createHoverMarkdownString(
            translatedText,
            humanizeText,
            uri,
            range,
            document,
            translateLink
        );
    }

    if (!res) return null;
    if (!range) return null;

    let showRange = range;
    if (nearShow) {
        const nearRange = new Range(
            new Position(position.line, Math.max(position.character - 10, 0)),
            new Position(position.line, position.character + 10)
        );
        showRange = range.intersection(nearRange) || showRange;
    }

    const hover = new Hover([res.header, res.md], showRange);
    last.set(uri, range);
    return hover;
}

async function translateTypeLanguageProvideHover(
    document: TextDocument,
    position: Position,
    _token: CancellationToken,
    canLanguages: string[]
): Promise<Hover | null> {

    // Return null if the current document does not support type language
    if (canLanguages.indexOf(document.languageId) < 0) return null;

    // translateTypeLanguage的开关，默认开启
    const typeLanguae = getConfig<boolean>("hover.content");
    if (!typeLanguae) return null;

    let hoverId = getHoverId(document, position);
    working.add(hoverId); // 标识当前位置进行处理中。  当前Provider将忽略当次请求，规避循环调用。
    let res = await commands.executeCommand<Hover[]>(
        "vscode.executeHoverProvider",
        document.uri,
        position
    );
    working.delete(hoverId); // 移除处理中的标识，使其他正常hover的响应
    // let targetLanguage = getConfig<string>('targetLanguage', userLanguage);

    // let contents:{tokens:IMarkdownReplceToken[]}[] = [];
    let contentTasks: Promise<{ result: string; hasTranslated: boolean }>[] =
        [];
    let range: Range | undefined;

    res.forEach((hover) => {
        range = range || hover.range;
        hover.contents.forEach(async (c) => {
            // TODO 先全量翻译,后续特殊场景定制优化
            let markdownText: string;
            // let tokens:IMarkdownReplceToken[];
            if (typeof c === "string") {
                markdownText = c;
            } else {
                markdownText = c.value;
            }
            contentTasks.push(getMarkdownTextValue(markdownText));
        });
    });

    let translateds = await Promise.all(contentTasks);

    let markdownStrings: MarkdownString[] = [];
    let i = 0;
    // 如果Hover分组中，所有内容都没有翻译，忽略这部分片段内容。
    res.forEach((hover) => {
        let hasTranslated = false;
        let temp: MarkdownString[] = [];
        for (let j = 0; j < hover.contents.length; j += 1) {
            let md = new MarkdownString(translateds[i].result, true);
            md.isTrusted = true;
            temp.push(md);
            if (translateds[i].hasTranslated === true) {
                hasTranslated = true;
            }
            i += 1;
        }
        if (hasTranslated) {
            markdownStrings = markdownStrings.concat(...temp);
        }
    });

    if (markdownStrings.length > 0) {
        return new Hover(markdownStrings, range);
    }
    return null;
}

async function diagnosticsProvideHover(
    document: TextDocument,
    position: Position
): Promise<Hover | null> {
    const diagnostics: Diagnostic[] = languages.getDiagnostics(document.uri);
    const contentTasks: Promise<{ result: string; hasTranslated: boolean }>[] =
        [];
    const filteredDiagnostics: Diagnostic[] = [];

    let range: Range | undefined;
    diagnostics.forEach((diagnostic) => {
        if (diagnostic.range.contains(position)) {
            range = range || diagnostic.range;
            contentTasks.push(getMarkdownTextValue(diagnostic.message));
            filteredDiagnostics.push(diagnostic);
        }
    });

    const translateds = await Promise.all(contentTasks);
    const markdownStrings: MarkdownString[] = [];
    translateds.forEach((translated, index) => {
        if (!translated.hasTranslated) return;
        let diagnostic = filteredDiagnostics[index];

        let codeText: string = "";
        if (
            typeof diagnostic.code === "string" ||
            typeof diagnostic.code === "number"
        ) {
            codeText = `${diagnostic.code}`;
        } else if (
            diagnostic.code &&
            diagnostic.code.value &&
            diagnostic.code.target
        ) {
            codeText = `[${diagnostic.code.value}](${diagnostic.code.target})`;
        }

        if (codeText) {
            codeText = `(${codeText})`;
        }
        const sourceText = `\`${diagnostic.source}\`${codeText}`;
        const md = new MarkdownString(translated.result + sourceText, true);
        md.isTrusted = true;
        markdownStrings.push(md);
    });

    if (markdownStrings.length > 0) {
        return new Hover(markdownStrings, range);
    }

    return null;
}

function getHoverId(document: TextDocument, position: Position) {
    return `${document.uri.toString()}-${position.line}-${position.character}`;
}

export function registerHover(
    context: ExtensionContext,
    canLanguages: string[] = []
) {
    let hoverProviderDisposable = languages.registerHoverProvider(
        '*',
        {
            async provideHover(document, position, token) {
                // hover开关配置，对typelanguage生效
                const open = getConfig<boolean>("hover.enabled");
                if (!open) return null;

                let hoverId = getHoverId(document, position);
                // 如果已经当前Hover进行中，则忽略本次请求
                if (working.has(hoverId)) {
                    return null;
                }

                let [typeLanguageHover, commentHover, diagnosticsHover] =
                    await Promise.all([
                        translateTypeLanguageProvideHover(
                            document,
                            position,
                            token,
                            canLanguages,
                        ),
                        commentProvideHover(document, position, token, canLanguages),
                        diagnosticsProvideHover(document, position),
                    ]);
                return mergeHovers(
                    commentHover,
                    diagnosticsHover,
                    typeLanguageHover
                );
            },
        }
    );
    context.subscriptions.push(hoverProviderDisposable);
}

function selectionContains(
    url: string,
    position: Position
): ICommentBlock | null {
    let editor = window.activeTextEditor;
    //有活动editor，并且打开文档与请求文档一致时处理请求
    if (editor && editor.document.uri.toString() === url) {
        //类型转换
        let selection = editor.selections.find((selection) => {
            return !selection.isEmpty && selection.contains(position);
        });

        if (selection) {
            return {
                range: selection,
                comment: editor.document.getText(selection),
            };
        }
    }

    return null;
}

export function lastHover(uri: string) {
    return last.get(uri);
}

function mergeHovers(...hovers: (Hover | null)[]): Hover | null {
    const filteredHovers = hovers.filter((hover) => hover !== null) as Hover[];
    const firstHover = filteredHovers.shift();
    if (!firstHover) return null;

    filteredHovers.forEach((hover) => {
        firstHover.contents = firstHover.contents.concat(hover.contents);
    });

    return firstHover;
}


function createHoverMarkdownString(
    translatedText: string,
    humanizeText: string | undefined,
    uri: string,
    range: { start: any, end: any },
    document: { languageId: string },
    translateLink: string
): { md: MarkdownString, header: MarkdownString } {
    const base64TranslatedText = Buffer.from(translatedText).toString("base64");
    const space = "&nbsp;&nbsp;";
    const separator = `${space}|${space}`;
    const replace = `[$(replace)](command:commentTranslate._replaceRange?${encodeURIComponent(
        JSON.stringify({
            uri,
            range: { start: range.start, end: range.end },
            text: base64TranslatedText,
        })
    )} "Replace")`;
    const multiLine = getConfig<boolean>("multiLineMerge");
    const combine = `[$(${multiLine ? "selection" : "remove"
        })](command:commentTranslate._toggleMultiLineMerge "Toggle Combine Multi Line")`;

    // bugfix: JSON.stringify Range会变成数组。 传到下游会有问题。
    const addSelection = `[$(heart)](command:commentTranslate._addSelection?${encodeURIComponent(
        JSON.stringify({ range: { start: range.start, end: range.end } })
    )} "Add Selection")`;

    const translate = `[$(sync)](command:commentTranslate.changeTranslateSource "Change translate source")`;

    const header = new MarkdownString(
        `[Better Comment Translate]${space}${replace}${space}${combine}${space}${addSelection}${separator}${translate}${space}${translateLink}`,
        true
    );
    header.isTrusted = true;

    let showText = translatedText;
    if (humanizeText) {
        showText = `${humanizeText} => ${translatedText}`;
    }
    const codeDefine = "```";
    let md = new MarkdownString(
        `${codeDefine}${document.languageId}\n${showText}\n ${codeDefine}`
    );
    if (!translatedText) {
        md = new MarkdownString(
            `**Translate Error**: Check [OutputPannel](command:commentTranslate._openOutputPannel "open output pannel") for details.`
        );
        md.isTrusted = true;
    }

    return { header, md };
}
