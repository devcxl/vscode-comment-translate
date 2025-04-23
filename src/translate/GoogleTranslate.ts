import {BaseTranslate} from './baseTranslate';
import {
    encodeMarkdownUriComponent,
    ITranslateOptions
} from 'comment-translate-manager';
import {getConfig} from '../configuration';
import {translate} from '@vitalets/google-translate-api';
import {HttpProxyAgent} from 'http-proxy-agent';

export class GoogleTranslate extends BaseTranslate {
    override readonly maxLen= 500;
    async _translate(content: string, { from = 'auto', to = 'auto' }: ITranslateOptions): Promise<string> {
        let proxy = getConfig<string>('googleTranslate.proxy', '');

        let options = {
            from:`${from}`,
            to:`${to}`
        } as { from: string; to: string; host?: string; fetchOptions?: any };

        if (proxy !== '') {
            options.fetchOptions.agent = new HttpProxyAgent(proxy);
        }
        const { text } = await translate(content, options);
        return text;
    }

    link(content: string, { to = 'auto',from='auto' }: ITranslateOptions): string {
        let str = `https://translate.google.com/#view=home&op=translate&sl=${from}&tl=${to}&text=${encodeMarkdownUriComponent(content)}`;
        return `[Google](${str})`;
    }
}
