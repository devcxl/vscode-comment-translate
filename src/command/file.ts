import { commands, env, ProgressLocation, Selection, window } from "vscode";
import { getConfig, selectTargetLanguage } from "../configuration";
import { ctx, outputChannel } from "../extension";
// import { client } from "../extension";
import { compileBlock } from "../syntax/compile";
import { createComment } from "../syntax/Comment";


export async function selectAllForType(type = 'comment') {
    let editor = window.activeTextEditor;
    if (editor) {
        // let blocks = await client.sendRequest<ICommentBlock[] | null>('getAllComment',{uri: editor.document.uri.toString(),type, range:{
        //     start: editor.selections[0].start,
        //     end: editor.selections[0].end
        // }});
        let comment = await createComment();
        let blocks = await comment.getAllComment(editor.document, type, editor.selections[0]);

        if (!blocks || blocks.length === 0) return;
        let selections = blocks.map((block => {
            const { start, end } = block.range;
            return new Selection(start.line, start.character, end.line, end.character);
        }));
        editor.selections = selections;
    }
}

export async function selectAllText() {
    return selectAllForType('text')
}

export async function selectAllComment() {
    selectAllForType('comment');
}

export async function translateAllText() {
    return translateAllForType('text')
}

export async function translateAllComment() {
    translateAllForType('comment');
}

export async function translateAllForType(type = 'comment') {
    let editor = window.activeTextEditor;

    window.withProgress({
        location: ProgressLocation.Window,
        title: 'Better Comment Translate'
    },
        async progress => {
            if (!editor) return;
            // let blocks = await client.sendRequest<ICommentBlock[] | null>('getAllComment',{uri: editor.document.uri.toString(),type,range:{
            //     start: editor.selections[0].start,
            //     end: editor.selections[0].end
            // }});

            progress.report({ message: 'Parsing' });
            let comment = await createComment();
            let blocks = await comment.getAllComment(editor.document, type, editor.selections[0]);


            if (!blocks || blocks.length === 0) return;

            let targetLanguage: string;
            let selectTarget = getConfig<boolean>('selectTargetLanguageWhenReplacing');
            if (selectTarget) {
                targetLanguage = await selectTargetLanguage();
                if (!targetLanguage) return;
            }
            let finishedRequests = 0
            // const translatedBlock = await compileBlock(block,document.languageId);

            // 开始请求 到 有第一个请求完成 之间可能也会间隔相当长的时间，所以开始请求时也应 report 一下进度
            progress.report({ message: 'Requesting' });

            let translates = blocks.map((async block => {
                const result = compileBlock(block, editor?.document.languageId!, targetLanguage).then(res => {
                    finishedRequests++;
                    progress.report({
                        message: `Translated ${finishedRequests} / ${blocks!.length}`
                    });
                    return res;
                });
                return result;
            }));
            let selections = blocks.map((block => {
                const { start, end } = block.range;
                return new Selection(start.line, start.character, end.line, end.character);
            }));

            //添加装饰，提醒用户正在翻译中。 部分内容会原样返回，避免用户等待
            let decoration = window.createTextEditorDecorationType({
                // color: '#FF2D00',
                // backgroundColor: "transparent",
                before: {
                    contentIconPath: ctx.asAbsolutePath('resources/icons/loading.svg'),
                }
            });
            editor.setDecorations(decoration, selections);
            let beginTime = Date.now();
            try {
                let results = await Promise.all(translates);
                //最少提示1秒钟
                setTimeout(() => {
                    decoration.dispose();
                }, 1000 - (Date.now() - beginTime));
                editor.edit(builder => {
                    results.forEach(({ translatedText }, index) => {
                        let selection = selections[index];
                        translatedText && builder.replace(selection, translatedText);
                    });
                });
            } catch (e: any) {
                decoration.dispose();
                outputChannel.append(e.toString());
            }

        })
}


let BlackLanguages = ['markdown', 'log'];

function wrapMarkdown(text: string, languageId: string) {
    if (BlackLanguages.includes(languageId)) {
        return text;
    }
    return `\`\`\`${languageId}
${text}
\`\`\``;
}

/**
 * Quickly translate selection or clipboard text for display on Github Copilot Chat
 */
export async function quickTranslationCommand() {

    let text: string;
    let editor = window.activeTextEditor;

    if (editor?.selection?.isEmpty === false && editor.document) {
        text = wrapMarkdown(editor.document.getText(editor.selection), editor.document.languageId);
    } else {
        text = await env.clipboard.readText();
    }

    commands.executeCommand('workbench.action.chat.open', {
        query: '@translate ' + text
    });

}
