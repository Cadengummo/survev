import * as PIXI from "pixi.js";
import { coldet } from "../../shared/utils/coldet";
import { collider } from "../../shared/utils/collider";
import { mapHelpers } from "../../shared/utils/mapHelpers";
import { generateJaggedAabbPoints, generateTerrain } from "../../shared/utils/terrainGen";
import { util } from "../../shared/utils/util";
import { v2 } from "../../shared/utils/v2";
import { Pool } from "./objects/objectPool";
import { device } from "./device";
import { math } from "../../shared/utils/math";
import { GameConfig } from "../../shared/gameConfig";
import { MapDefs } from "../../shared/defs/mapDefs";
import { MapObjectDefs } from "../../shared/defs/mapObjectDefs";
import { Building } from "./objects/building";
import { Obstacle } from "./objects/obstacle";
import { Structure } from "./objects/structure";

// Drawing

function drawLine(canvas, pt0, pt1) {
    canvas.moveTo(pt0.x, pt0.y);
    canvas.lineTo(pt1.x, pt1.y);
}
function tracePath(canvas, path) {
    let point = path[0];
    canvas.moveTo(point.x, point.y);
    for (let i = 1; i < path.length; ++i) {
        point = path[i];
        canvas.lineTo(point.x, point.y);
    }
    canvas.closePath();
}
function traceGroundPatch(canvas, patch, seed) {
    const width = patch.max.x - patch.min.x;
    const height = patch.max.y - patch.min.y;

    const offset = math.max(patch.offsetDist, 0.001);
    const roughness = patch.roughness;

    const divisionsX = Math.round((width * roughness) / offset);
    const divisionsY = Math.round((height * roughness) / offset);

    const seededRand = util.seededRand(seed);
    tracePath(canvas, generateJaggedAabbPoints(patch, divisionsX, divisionsY, offset, seededRand));
}

export class Map {
    /**
     * @param {import("./objects/decal").DecalBarn} decalBarn
     */
    constructor(decalBarn) {
        this.decalBarn = decalBarn;
        this.I = false;
        this.Br = false;
        this.display = {
            ground: new PIXI.Graphics()
        };
        this.mapName = "";
        this.mapDef = {};
        this.factionMode = false;
        this.perkMode = false;
        this.turkeyMode = false;
        this.seed = 0;
        this.width = 0;
        this.height = 0;
        this.terrain = {};
        this.mapData = {
            places: [],
            objects: [],
            groundPatches: []
        };
        this.mapLoaded = false;
        this.mapTexture = null;
        this.Ve = new Pool(Obstacle);
        this.nr = new Pool(Building);
        this.lr = new Pool(Structure);
        this.deadObstacleIds = [];
        this.deadCeilingIds = [];
        this.solvedPuzzleIds = [];
        this.lootDropSfxIds = [];
        this.terrain = null;
        this.cameraEmitter = null;

        // Anti-cheat
        this.ea = 0;
        this._r = false;
        this.U = false;
    }

    free() {
        // Buildings need to stop sound emitters
        const buildings = this.nr.p();
        for (
            let i = 0; i < buildings.length; i++) {
            buildings[i].n();
        }
        this.mapTexture?.destroy(true);
        this.display.ground.destroy({
            children: true
        });
        this.cameraEmitter?.stop();
        this.cameraEmitter = null;
    }

    resize(pixiRenderer, canvasMode) {
        this.renderMap(pixiRenderer, canvasMode);
    }

    loadMap(mapMsg, camera, canvasMode, particleBarn) {
        this.mapName = mapMsg.mapName;
        // Clone the source mapDef
        const mapDef = MapDefs[this.mapName];
        if (!mapDef) {
            throw new Error(
                `Failed loading mapDef ${this.mapName}`
            );
        }
        this.mapDef = util.cloneDeep(mapDef);
        this.factionMode = !!this.mapDef.gameMode.factionMode;
        this.perkMode = !!this.mapDef.gameMode.perkMode;
        this.turkeyMode = !!this.mapDef.gameMode.turkeyMode;
        this.seed = mapMsg.seed;
        this.width = mapMsg.width;
        this.height = mapMsg.height;
        this.terrain = generateTerrain(
            this.width,
            this.height,
            mapMsg.shoreInset,
            mapMsg.grassInset,
            mapMsg.rivers,
            this.seed
        );
        this.mapData = {
            places: mapMsg.places,
            objects: mapMsg.objects,
            groundPatches: mapMsg.groundPatches
        };
        this.mapLoaded = true;
        const cameraEmitterType = this.mapDef.biome.particles.camera;
        if (cameraEmitterType) {
            const dir = v2.normalize(v2.create(1, -1));
            this.cameraEmitter = particleBarn.addEmitter(cameraEmitterType, {
                pos: v2.create(0, 0),
                dir,
                layer: 99999
            });
        }
        this.display.ground.clear();
        this.renderTerrain(
            this.display.ground,
            2 / camera.ppu,
            canvasMode,
            false
        );
    }

    getMapDef() {
        if (!this.mapLoaded) {
            throw new Error("Map not loaded!");
        }
        return this.mapDef;
    }

    getMapTexture() {
        return this.mapTexture;
    }

    update(dt, activePlayer, r, a, i, o, s, camera, smokeParticles, c) {
        this.I = true;
        this.Br = true;
        const obstacles = this.Ve.p();
        for (let h = 0; h < obstacles.length; h++) {
            const u = obstacles[h];
            if (u.active) {
                u.m(dt, this, r, a, i, activePlayer, s);
                u.render(camera, c, activePlayer.layer);
            }
        }
        for (let y = this.nr.p(), f = 0; f < y.length; f++) {
            const _ = y[f];
            if (_.active) {
                _.m(dt, this, a, i, o, activePlayer, s, camera);
                _.render(camera, c, activePlayer.layer);
            }
        }
        for (let b = this.lr.p(), x = 0; x < b.length; x++) {
            const S = b[x];
            if (S.active) {
                S.update(dt, this, activePlayer, o);
                S.render(camera, c, activePlayer.layer);
            }
        }
        if (this.cameraEmitter) {
            this.cameraEmitter.pos = v2.copy(camera.pos);
            this.cameraEmitter.enabled = true;

            // Adjust radius and spawn rate based on zoom
            const maxRadius = 120;
            const camRadius = activePlayer.yr() * 2.5;
            this.cameraEmitter.radius = math.min(camRadius, maxRadius);
            const radius = this.cameraEmitter.radius;
            const ratio = (radius * radius) / (maxRadius * maxRadius);
            this.cameraEmitter.rateMult = 1 / ratio;
            const alphaTarget = activePlayer.layer == 0 ? 1 : 0;
            this.cameraEmitter.alpha = math.lerp(
                dt * 6,
                this.cameraEmitter.alpha,
                alphaTarget
            );
        }
        this.ea++;
        if (this.ea % 180 == 0) {
            this._r = true;
            let cheatDetected = 0;
            const detectCheatAlphaFn = mapHelpers.ct;

            // Verify smoke particle alpha integrity
            for (let i = 0; i < smokeParticles.length; i++) {
                const p = smokeParticles[i];
                if (p.active && !p.fade && detectCheatAlphaFn(p, mapHelpers.nt)) {
                    cheatDetected++;
                }
            }

            // Verify obstacle alpha integrity
            for (let i = 0; i < obstacles.length; i++) {
                const p = obstacles[i];
                if (p.active && !p.dead && detectCheatAlphaFn(p, mapHelpers.lt)) {
                    cheatDetected++;
                }
            }
            if (cheatDetected) {
                this.U = true;
            }
        }
    }

    renderTerrain(groundGfx, gridThickness, canvasMode, mapRender) {
        const width = this.width;
        const height = this.height;
        const terrain = this.terrain;
        const ll = {
            x: 0,
            y: 0
        };
        const lr = {
            x: width,
            y: 0
        };
        const ul = {
            x: 0,
            y: height
        };
        const ur = {
            x: width,
            y: height
        };
        const mapColors = this.mapDef.biome.colors;
        const groundPatches = this.mapData.groundPatches;
        groundGfx.beginFill(mapColors.background);
        groundGfx.drawRect(-120, -120, width + 240, 120);
        groundGfx.drawRect(-120, height, width + 240, 120);
        groundGfx.drawRect(-120, -120, 120, height + 240);
        groundGfx.drawRect(width, -120, 120, height + 240);
        groundGfx.endFill();
        groundGfx.beginFill(mapColors.beach);
        tracePath(groundGfx, terrain.shore);
        groundGfx.beginHole();
        tracePath(groundGfx, terrain.grass);
        // groundGfx.addHole();
        groundGfx.endHole();
        groundGfx.endFill();

        // As mentioned above, don't explicitly render a grass polygon;
        // there's a hole left where the grass should be, with the background
        // clear color set to the grass color.
        //
        // ... except we have to for canvas mode!
        if (canvasMode) {
            groundGfx.beginFill(mapColors.grass);
            tracePath(groundGfx, terrain.grass);
            groundGfx.endFill();
        }

        // Order 0 ground patches
        for (let i = 0; i < groundPatches.length; i++) {
            const patch = groundPatches[i];
            if (patch.order == 0 && (!mapRender || !!patch.useAsMapShape)) {
                groundGfx.beginFill(patch.color);
                traceGroundPatch(groundGfx, patch, this.seed);
                groundGfx.endFill();
            }
        }

        // River shore
        groundGfx.beginFill(mapColors.riverbank);

        // groundGfx.lineStyle(2, 0xff0000);

        for (let i = 0; i < terrain.rivers.length; i++) {
            tracePath(groundGfx, terrain.rivers[i].shorePoly);
        }
        groundGfx.endFill();
        groundGfx.beginFill(mapColors.water);
        for (let b = 0; b < terrain.rivers.length; b++) {
            tracePath(groundGfx, terrain.rivers[b].waterPoly);
        }
        groundGfx.endFill();

        // Water
        groundGfx.beginFill(mapColors.water);
        groundGfx.moveTo(ul.x, ul.y);
        groundGfx.lineTo(ur.x, ur.y);
        groundGfx.lineTo(lr.x, lr.y);
        groundGfx.lineTo(ll.x, ll.y);
        groundGfx.beginHole();
        tracePath(groundGfx, terrain.shore);
        // e.addHole();
        groundGfx.endHole();
        groundGfx.closePath();
        groundGfx.endFill();

        // Grid
        const gridGfx = groundGfx;
        gridGfx.lineStyle(gridThickness, 0, 0.15);
        for (let x = 0; x <= width; x += GameConfig.map.gridSize) {
            drawLine(
                gridGfx,
                {
                    x,
                    y: 0
                },
                {
                    x,
                    y: height
                }
            );
        }
        for (let y = 0; y <= height; y += GameConfig.map.gridSize) {
            drawLine(
                gridGfx,
                {
                    x: 0,
                    y
                },
                {
                    x: width,
                    y
                }
            );
        }
        gridGfx.lineStyle(gridThickness, 0, 0);

        // Order 1 ground patches
        for (let i = 0; i < groundPatches.length; i++) {
            const patch = groundPatches[i];
            if (patch.order == 1 && (!mapRender || !!patch.useAsMapShape)) {
                groundGfx.beginFill(patch.color);
                traceGroundPatch(groundGfx, patch, this.seed);
                groundGfx.endFill();
            }
        }
    }

    render(camera) {
        // Terrain
        // Fairly robust way to get translation and scale from the camera ...
        const p0 = camera.pointToScreen(v2.create(0, 0));
        const p1 = camera.pointToScreen(v2.create(1, 1));
        const s = v2.sub(p1, p0);
        // Translate and scale the map polygons to move the with camera
        this.display.ground.position.set(p0.x, p0.y);
        this.display.ground.scale.set(s.x, s.y);
    }

    getMinimapRender(obj) {
        const def = MapObjectDefs[obj.type];
        const zIdx =
            def.type == "building"
                ? 750 + (def.zIdx || 0)
                : def.img.zIdx || 0;
        let shapes = [];
        if (def.map.shapes !== undefined) {
            shapes = def.map.shapes;
        } else {
            let col = null;
            if (
                (col =
                    def.type == "obstacle"
                        ? def.collision
                        : def.ceiling.zoomRegions.length > 0 &&
                            def.ceiling.zoomRegions[0].zoomIn
                            ? def.ceiling.zoomRegions[0].zoomIn
                            : mapHelpers.getBoundingCollider(obj.type))
            ) {
                shapes.push({
                    collider: collider.copy(col),
                    scale: def.map.scale || 1,
                    color: def.map.color
                });
            }
        }
        return {
            obj,
            zIdx,
            shapes
        };
    }

    /**
     * @param {PIXI.Renderer} renderer
     * @param {boolean} canvasMode
     */
    renderMap(renderer, canvasMode) {
        if (this.mapLoaded) {
            const mapRender = new PIXI.Container();
            const txtRender = new PIXI.Container();
            const mapColors = this.mapDef.biome.colors;
            const places = this.mapData.places;
            const objects = this.mapData.objects;
            let screenScale = device.screenHeight;
            if (device.mobile) {
                if (!device.isLandscape) {
                    screenScale = device.screenWidth;
                }
                screenScale *= math.min(device.pixelRatio, 2);
            }
            const scale = this.height / screenScale;

            // Background
            const background = new PIXI.Graphics();
            background.beginFill(mapColors.grass);
            background.drawRect(0, 0, this.width, this.height);
            background.endFill();
            this.renderTerrain(background, scale, canvasMode, true);

            // Border for extra spiffiness
            const ll = {
                x: 0,
                y: 0
            };
            const lr = {
                x: this.width,
                y: 0
            };
            const ul = {
                x: 0,
                y: this.height
            };
            const ur = {
                x: this.width,
                y: this.height
            };
            background.lineStyle(scale * 2, 0, 1);
            drawLine(background, ll, ul);
            drawLine(background, ul, ur);
            drawLine(background, ur, lr);
            drawLine(background, lr, ll);
            background.position.y = this.height;
            background.scale.y = -1;

            mapRender.addChild(background);

            // Render minimap objects, sorted by zIdx
            const minimapRenders = [];
            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                minimapRenders.push(this.getMinimapRender(obj));
            }
            minimapRenders.sort((a, b) => {
                return a.zIdx - b.zIdx;
            });

            const gfx = new PIXI.Graphics();
            for (let i = 0; i < minimapRenders.length; i++) {
                const render = minimapRenders[i];
                const obj = render.obj;
                for (
                    let j = 0;
                    j < render.shapes.length;
                    j++
                ) {
                    const shape = render.shapes[j];
                    const col = collider.transform(
                        shape.collider,
                        obj.pos,
                        math.oriToRad(obj.ori),
                        obj.scale
                    );
                    const scale = shape.scale !== undefined ? shape.scale : 1;
                    gfx.beginFill(shape.color, 1);
                    switch (col.type) {
                    case collider.Type.Circle:
                        gfx.drawCircle(
                            col.pos.x,
                            this.height - col.pos.y,
                            col.rad * scale
                        );
                        break;
                    case collider.Type.Aabb: {
                        let A = v2.mul(v2.sub(col.max, col.min), 0.5);
                        const O = v2.add(col.min, A);
                        A = v2.mul(A, scale);
                        gfx.drawRect(
                            O.x - A.x,
                            this.height - O.y - A.y,
                            A.x * 2,
                            A.y * 2
                        );
                        gfx.endFill();
                    }
                    }
                }
            }
            mapRender.addChild(gfx);

            // Place names
            const nameContainer = new PIXI.Container();
            for (let E = 0; E < places.length; E++) {
                const place = places[E];
                const style = new PIXI.TextStyle({
                    fontFamily: "Arial",
                    fontSize: device.mobile ? 20 : 22,
                    fontWeight: "bold",
                    fill: ["#ffffff"],
                    stroke: "#000000",
                    strokeThickness: 1,
                    dropShadow: true,
                    dropShadowColor: "#000000",
                    dropShadowBlur: 1,
                    dropShadowAngle: Math.PI / 3,
                    dropShadowDistance: 1,
                    wordWrap: false,
                    align: "center"
                });
                const richText = new PIXI.Text(place.name, style);
                richText.anchor.set(0.5, 0.5);
                richText.x = (place.pos.x * this.height) / scale;
                richText.y = (place.pos.y * this.height) / scale;
                richText.alpha = 0.75;
                nameContainer.addChild(richText);
            }
            txtRender.addChild(nameContainer);

            // Generate and/or update the texture
            if (this.mapTexture) {
                this.mapTexture.resize(screenScale, screenScale);
            } else {
                this.mapTexture = PIXI.RenderTexture.create({
                    width: screenScale,
                    height: screenScale,
                    scaleMode: PIXI.SCALE_MODES.LINEAR,
                    resolution: 1
                });
            }
            mapRender.scale = new PIXI.Point(screenScale / this.height, screenScale / this.height);
            renderer.render(mapRender, {
                renderTexture: this.mapTexture,
                clear: true
            });
            renderer.render(txtRender, {
                renderTexture: this.mapTexture,
                clear: false
            });
            mapRender.destroy({
                children: true,
                texture: true,
                baseTexture: true
            });
            txtRender.destroy({
                children: true,
                texture: true,
                baseTexture: true
            });
        }
    }

    getGroundSurface(pos, layer) {
        const r = this;
        const groundSurface = (type, data = {}) => {
            if (type == "water") {
                const mapColors = r.getMapDef().biome.colors;
                data.waterColor =
                    data.waterColor !== undefined
                        ? data.waterColor
                        : mapColors.water;
                data.rippleColor =
                    data.rippleColor !== undefined
                        ? data.rippleColor
                        : mapColors.waterRipple;
            }
            return {
                type,
                data
            };
        };

        // Check decals
        const decals = this.decalBarn._.p();
        for (
            let i = 0;
            i < decals.length;
            i++
        ) {
            const decal = decals[i];
            if (
                decal.active &&
                decal.surface &&
                util.sameLayer(decal.layer, layer) &&
                collider.intersectCircle(decal.collider, pos, 0.0001)
            ) {
                return groundSurface(decal.surface.type, decal.surface.data);
            }
        }

        // Check buildings
        let surface = null;
        let zIdx = 0;
        const onStairs = layer & 2;
        const buildings = this.nr.p();
        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            if (
                building.active &&
                building.zIdx >= zIdx &&
                // Prioritize layer0 building surfaces when on stairs
                (building.layer == layer || !!onStairs) &&
                (building.layer != 1 || !onStairs)
            ) {
                for (let i = 0; i < building.surfaces.length; i++) {
                    const s = building.surfaces[i];
                    for (
                        let j = 0;
                        j < s.colliders.length;
                        j++
                    ) {
                        const res = collider.intersectCircle(
                            s.colliders[j],
                            pos,
                            0.0001
                        );
                        if (res) {
                            zIdx = building.zIdx;
                            surface = s;
                            break;
                        }
                    }
                }
            }
        }
        if (surface) {
            return groundSurface(surface.type, surface.data);
        }

        // Check rivers
        let onRiverShore = false;
        if (layer != 1) {
            const rivers = this.terrain.rivers;
            for (
                let v = 0;
                v < rivers.length;
                v++
            ) {
                const river = rivers[v];
                if (
                    coldet.testPointAabb(pos, river.aabb.min, river.aabb.max) &&
                    math.pointInsidePolygon(pos, river.shorePoly) &&
                    ((onRiverShore = true),
                    math.pointInsidePolygon(pos, river.waterPoly))
                ) {
                    return groundSurface("water", {
                        river
                    });
                }
            }
        }
        // Check terrain
        return groundSurface(
            math.pointInsidePolygon(pos, this.terrain.grass)
                ? onRiverShore
                    // Use a stone step sound if we're in the main-spring def
                    ? this.mapDef.biome.sound.riverShore
                    : "grass"
                : math.pointInsidePolygon(pos, this.terrain.shore)
                    ? "sand"
                    : "water"
        );
    }

    isInOcean(pos) {
        return !math.pointInsidePolygon(pos, this.terrain.shore);
    }

    distanceToShore(pos) {
        return math.distToPolygon(pos, this.terrain.shore);
    }

    insideStructureStairs(collision) {
        const structures = this.lr.p();
        for (let i = 0; i < structures.length; i++) {
            const structure = structures[i];
            if (structure.active && structure.insideStairs(collision)) {
                return true;
            }
        }
        return false;
    }

    getBuildingById(objId) {
        const buildings = this.nr.p();
        for (let r = 0; r < buildings.length; r++) {
            const building = buildings[r];
            if (building.active && building.__id == objId) {
                return building;
            }
        }
        return null;
    }

    insideStructureMask(collision) {
        const structures = this.lr.p();
        for (let i = 0; i < structures.length; i++) {
            const structure = structures[i];
            if (structure.active && structure.insideMask(collision)) {
                return true;
            }
        }
        return false;
    }

    insideBuildingCeiling(collision, checkVisible) {
        const buildings = this.nr.p();
        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            if (
                building.active &&
                (!checkVisible ||
                    (building.ceiling.visionTicker > 0 &&
                        !building.ceilingDead)) &&
                building.isInsideCeiling(collision)
            ) {
                return true;
            }
        }
        return false;
    }
}
