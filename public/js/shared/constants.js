// Shared constants used by both the browser client and the Node server.

export const TILE = 32;            // pixel size of one tile
export const WORLD_W = 100;        // world width in tiles
export const WORLD_H = 54;         // world height in tiles
export const SKY_ROWS = 22;        // rows of sky/air before the ground surface

// Physics (pixels, seconds)
export const GRAVITY = 2000;
export const MOVE_SPEED = 230;
export const JUMP_VELOCITY = 660;
export const MAX_FALL = 1400;

// Player body (pixels). Rendered exactly one block tall (see game.js), but the
// COLLISION box is a hair under a tile so the player fits cleanly through
// 1-block-tall gaps (an exactly-32px box overlaps the next row by the floor
// epsilon and reads as 2 tiles tall).
export const PLAYER_W = 22;
export const PLAYER_H = TILE - 2;

// Gameplay
export const BREAK_RESET_MS = 5000;   // damaged blocks fully recover after this idle time
export const DROP_LIFETIME_MS = 90000; // dropped items despawn after this
export const PICKUP_RADIUS = 34;      // px distance to auto-collect drops
export const REACH = 3;               // how many tiles away a player can build/break
export const RESPAWN_MS = 1600;       // death animation length before respawn

export const LAYER_FG = 0;
export const LAYER_BG = 1;
