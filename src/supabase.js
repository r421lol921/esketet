// Supabase client for Faundry game publishing & explore
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://yiiiukhwhjsatwxbzfjr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpaWl1a2h3aGpzYXR3eGJ6ZmpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDQ4MDIsImV4cCI6MjA5NzAyMDgwMn0.-NHST7jqeIUPUUqZ0cbEBreECNTiZ04dxSo-6trXDfs';

const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function getSupabase() {
    return _supabase;
}

/**
 * Publish a game to Supabase.
 * @param {{ name: string, author: string, thumb_url?: string, world_data: any }} payload
 * @returns {Promise<{ id: string }>}
 */
export async function publishGame(payload) {
    const sb = await getSupabase();
    const { data, error } = await sb.from('games').insert({
        name: payload.name,
        author: payload.author || 'Unknown',
        thumb_url: payload.thumb_url || '/DefaultThumb.png',
        world_data: payload.world_data,
        visits: 0,
        up: 0,
        down: 0
    }).select('id').single();
    if (error) throw error;
    return data;
}

/**
 * Fetch published games from Supabase ordered by newest first.
 * @returns {Promise<Array>}
 */
export async function fetchGames() {
    const sb = await getSupabase();
    const { data, error } = await sb
        .from('games')
        .select('id, name, author, thumb_url, visits, up, down, created_at, world_data')
        .order('created_at', { ascending: false })
        .limit(100);
    if (error) throw error;
    return data || [];
}

/**
 * Increment visit count for a game.
 * @param {string} gameId
 */
export async function incrementVisit(gameId) {
    try {
        const sb = await getSupabase();
        // Use rpc or a simple update with current value + 1
        await sb.rpc('increment_visits', { game_id: gameId }).catch(() => {
            // Fallback: fetch current then update
        });
    } catch (e) {
        // non-critical
    }
}

/**
<<<<<<< HEAD
 * Save a player's avatar to Supabase.
 * @param {{ username: string, colors: object, hatData?: object, avatarDataUrl?: string }} payload
 * @returns {Promise<void>}
 */
export async function saveAvatar(payload) {
    try {
        const sb = await getSupabase();
        const { error } = await sb.from('player_profiles').upsert({
            username: payload.username,
            colors: payload.colors,
            hat_data: payload.hatData || null,
            avatar_data_url: payload.avatarDataUrl || null,
            updated_at: new Date().toISOString()
        }, { onConflict: 'username' });
        if (error) console.warn('[v0] saveAvatar error:', error.message);
    } catch (e) {
        console.warn('[v0] saveAvatar failed:', e);
    }
}

/**
 * Load a player's avatar from Supabase.
 * @param {string} username
 * @returns {Promise<object|null>}
 */
export async function loadAvatar(username) {
    try {
        const sb = await getSupabase();
        const { data, error } = await sb
            .from('player_profiles')
            .select('username, colors, hat_data, avatar_data_url, updated_at')
            .eq('username', username)
            .maybeSingle();
        if (error) { console.warn('[v0] loadAvatar error:', error.message); return null; }
        return data;
    } catch (e) {
        console.warn('[v0] loadAvatar failed:', e);
        return null;
    }
}

/**
 * Fetch all marketplace listings from Supabase.
 * @returns {Promise<Array>}
 */
export async function fetchMarketplaceListings() {
    try {
        const sb = await getSupabase();
        const { data, error } = await sb
            .from('marketplace_items')
            .select('id, seller, name, description, price, image_url, created_at, sales')
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) { console.warn('[v0] fetchMarketplaceListings error:', error.message); return []; }
        return data || [];
    } catch (e) {
        console.warn('[v0] fetchMarketplaceListings failed:', e);
        return [];
    }
}

/**
 * Create a new marketplace listing.
 * @param {{ seller: string, name: string, description: string, price: number, image_url: string }} payload
 * @returns {Promise<object|null>}
 */
export async function createMarketplaceListing(payload) {
    try {
        const sb = await getSupabase();
        const { data, error } = await sb.from('marketplace_items').insert({
            seller: payload.seller,
            name: payload.name,
            description: payload.description || '',
            price: payload.price,
            image_url: payload.image_url || '',
            sales: 0
        }).select('id').single();
        if (error) throw error;
        return data;
    } catch (e) {
        console.warn('[v0] createMarketplaceListing failed:', e);
        return null;
    }
}

/**
 * Upload a T-shirt image to Supabase Storage.
 * Returns the public URL or null on failure.
 * @param {File} file
 * @param {string} sellerId  – used as filename prefix
 * @returns {Promise<string|null>}
 */
export async function uploadTshirtImage(file, sellerId) {
    try {
        const sb = await getSupabase();
        const ext = file.name.split('.').pop() || 'png';
        const path = `tshirts/${sellerId}_${Date.now()}.${ext}`;
        const { error } = await sb.storage.from('game-thumbs').upload(path, file, {
            cacheControl: '3600',
            upsert: true,
            contentType: file.type || 'image/png'
        });
        if (error) { console.warn('[v0] T-shirt upload error:', error.message); return null; }
        const { data } = sb.storage.from('game-thumbs').getPublicUrl(path);
        return data?.publicUrl || null;
    } catch (e) {
        console.warn('[v0] uploadTshirtImage failed:', e);
        return null;
    }
}

/**
=======
>>>>>>> origin/creator-and-explore-games
 * Upload a thumbnail image to Supabase Storage.
 * Returns the public URL or null on failure.
 * @param {File} file
 * @param {string} gameId  – used as filename prefix
 * @returns {Promise<string|null>}
 */
export async function uploadThumbnail(file, gameId) {
    try {
        const sb = await getSupabase();
        const ext = file.name.split('.').pop() || 'png';
        const path = `thumbs/${gameId}_${Date.now()}.${ext}`;
        const { error } = await sb.storage.from('game-thumbs').upload(path, file, {
            cacheControl: '3600',
            upsert: true,
            contentType: file.type || 'image/png'
        });
        if (error) {
            console.warn('[v0] Thumbnail upload error:', error.message);
            return null;
        }
        const { data } = sb.storage.from('game-thumbs').getPublicUrl(path);
        return data?.publicUrl || null;
    } catch (e) {
        console.warn('[v0] uploadThumbnail failed:', e);
        return null;
    }
}
