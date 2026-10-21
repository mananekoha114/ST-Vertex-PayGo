/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

// ST 1.18's non-streaming signature extractor returns from inside forEach.
// Bind the plugin's complete native signature to the exact chat being generated
// and write it while saveReply emits MESSAGE_RECEIVED, before the host saves.
export function createGemini4SignatureTracker({ getContext, context }) {
    let epoch = 0;
    let pending = null;
    const events = context.eventTypes ?? {};
    const reset = () => { epoch++; pending = null; };
    const receive = messageId => {
        const current = getContext();
        const entry = pending;
        if (!entry || entry.epoch !== epoch || entry.chat !== current?.chat
            || entry.chatId !== current?.getCurrentChatId?.()) return;
        const message = current.chat?.[messageId];
        if (!message || message.is_user || message.extra?.api !== entry.source
            || message.extra?.model !== entry.model) return;
        pending = null;
        message.extra.reasoning_signature = entry.signature;
        const variant = message.swipe_info?.[message.swipe_id ?? 0];
        if (variant) {
            variant.extra ??= {};
            variant.extra.reasoning_signature = entry.signature;
        }
    };
    const listeners = [['GENERATION_STARTED', reset], ['CHAT_CHANGED', reset], ['MESSAGE_RECEIVED', receive]];
    for (const [key, listener] of listeners) if (events[key]) context.eventSource?.on?.(events[key], listener);
    return {
        capture(data, background) {
            if (background || data.stream) return null;
            const current = getContext();
            if (!Array.isArray(current?.chat)) return null;
            return { epoch, chat: current.chat, chatId: current.getCurrentChatId?.(),
                source: data.chat_completion_source, model: data.model };
        },
        async observe(token, response) {
            if (!token || !response?.ok || typeof response.clone !== 'function') return;
            const data = await response.clone().json();
            if (token.epoch === epoch && typeof data.nativeGeminiSignature === 'string') {
                pending = { ...token, signature: data.nativeGeminiSignature };
            }
        },
        cleanup() {
            reset();
            for (const [key, listener] of listeners) if (events[key]) context.eventSource?.removeListener?.(events[key], listener);
        },
    };
}
