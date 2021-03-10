import {} from '@figma/plugin-typings'

export {
    pluginSettings,
    sendSettings
}

import {
    PluginSettings,
    Database,
    LatexState,
    MessageToCode,
} from './plugin-types'

import {
    matematykData,
    latexitOne,
    latexitTwo,
    matematykWord
} from './matematyk'

import {
    Rect
} from '../viewer/transform'
import {
    SlideEvent
} from '../viewer/types';

//*** global variables */

//saved selection when temporarily selecting an object through mouseover 
let savedSelection: readonly SceneNode[];

//the data for the current slide, mainly the event list
let database: Database = null;
//the current slide, as a frame of figma
let currentSlide: FrameNode = null;

//the plugin settings
let pluginSettings: PluginSettings;





//********* settings *********/
//get the settings from the ui
function getSettings(settings: PluginSettings): void {
    pluginSettings = settings;
    figma.clientStorage.setAsync('slajdomat', JSON.stringify(settings));
    sendSettings();
}

//send the settings to the ui
function sendSettings(): void {
    figma.ui.postMessage({
        type: 'settings',
        settings: pluginSettings
    });
}

//initialize the settings for the plugin
function initPlugin() {

    figma.clientStorage.getAsync('slajdomat').then(
        x => {
            //the default plugin settings
            const defaultSettings = {
                words: ['∀', '∃', '∧', '∨', '∈'],
                active: false,
                mathFont: {
                    family: 'STIXGeneral',
                    style: 'Regular'
                },
                mathFontSize: 1,
                serverURL : 'http://localhost:3001',
                latexitURL : 'https://latex.codecogs.com/svg.latex?'
            }

            try {
                pluginSettings = {...defaultSettings, ...JSON.parse(x)};
            } catch (e) {
                pluginSettings = defaultSettings;
            }
            sendSettings();
            selChange();
        }
    )
}

//Creates a new slide of given width and height. The place for the new slide is chosen to be close to the current slide.
function createNewSlide(width: number, height: number): FrameNode {
    const nodes = allSlides();

    //does rectangle a intersect any frame
    function intersectsNothing(a: Rect) {
        function intersects(a: Rect, b: FrameNode) {
            if (a.x > b.x + b.width || a.x + a.width < b.x)
                return false;
            if (a.y > b.y + b.height || a.y + a.height < b.y)
                return false;
            return true;
        }
        for (const b of nodes)
            if (intersects(a, b))
                return false;
        return true;
    }

    const candidate: Rect = {
        width: width,
        height: height,
        x: 0,
        y: 0
    };

    if (currentSlide == null) {
        candidate.x = 0;
        candidate.y = 0;
    } else {
        //search for free space below the current slide,
        //using the city metric
        let i = 0;
        let searching = true;
        while (searching) {
            i++;
            for (let j = 0; j < i && searching; j++) {
                candidate.x = currentSlide.x + j * width;
                candidate.y = currentSlide.y + (i + 0.2) * height;
                if (intersectsNothing(candidate)) {
                    searching = false;
                    break;
                }
                candidate.x = currentSlide.x + (i + 0.2) * width;
                candidate.y = currentSlide.y + j * height;
                if (intersectsNothing(candidate)) {
                    searching = false;
                    break;
                }
                candidate.x = currentSlide.x - j * width;
                candidate.y = currentSlide.y + (i + 0.2) * height;
                if (intersectsNothing(candidate)) {
                    searching = false;
                    break;
                }
                candidate.x = currentSlide.x - (i + 0.2) * width;
                candidate.y = currentSlide.y + j * height;
                if (intersectsNothing(candidate))
                    searching = false;
            }
        }
    }

    const newSlide = figma.createFrame();
    newSlide.x = candidate.x;
    newSlide.y = candidate.y
    newSlide.resize(width, height);
    return newSlide;
}


//send the  list which says what are the possible candidates for child slides. 
function sendDropDownList() {
    const msg = {
        type: 'dropDownContents',
        slides: [] as {
            name: string,
            id: string
        } []
    }


    for (const node of allSlides())
        if (node.id != currentSlide.id) {
            let alreadyChild = false;
            for (const e of database.events) {
                if (e.type == "child" && e.id == node.id) {
                    alreadyChild = true;
                }
            }
            if (!alreadyChild)
                msg.slides.push({
                    name: node.name,
                    id: node.id
                });
        }


    figma.ui.postMessage(msg);
}


//send the event list of the current slide
function sendEventList() {
    cleanDatabase();
    figma.ui.postMessage({
        type: 'eventList',
        events: database.events
    });
}



//Creates a child event in the current slide, together with a child link (as described in the previous function) that represents the child. 
function createChildEvent(id: string): RectangleNode {

    const slide: FrameNode = findSlide(id);
    database.events.push({
        type: "child",
        id: id,
        name: slide.name,
        merged: false,
        children: []
    });

    const width = 100;
    const rect = figma.createRectangle();
    rect.resize(width, width * slide.height / slide.width);
    rect.fills = [{
        type: 'SOLID',
        color: {
            r: 1,
            g: 0,
            b: 0
        }
    }];
    rect.opacity = 0.5;
    rect.setPluginData("childLink", id)
    rect.name = "Link to " + slide.name;
    currentSlide.appendChild(rect);
    rect.x = 100
    rect.y = 100
    return rect;

}


// create new event 
//msg.subtype says what kind it is, values are 'child', 'show', 'hide', etc.
//msg.id is used for the 'child' event
function createEvent(eventInfo: {
    type: 'createEvent',
    subtype: string,
    id: string,
    name: string
}): void {

    //returns the contents the longest text node in the descendants. Used to select a name for a group node
    function goodName(node: SceneNode): string {
        //give the list of all texts used in descendants
        function allTexts(n: SceneNode): string[] {
            if (n.type == 'TEXT') {
                return [n.name];
            }
            if (n.type == 'GROUP') {
                let retval: string[] = [];
                for (const child of n.children) {
                    retval = retval.concat(allTexts(child as SceneNode))
                }
                return retval;
            }
            //otherwise there are no strings
            return [];
        }
        const texts = allTexts(node);

        //if there is no text, do not change the name
        if (texts.length == 0)
            return node.name;

        //otherwise, return the longest text    
        let retval = texts[0];
        for (const text of texts) {
            if (text.length > retval.length)
                retval = text;
        }
        return retval
    }

    if (eventInfo.subtype == 'show' || eventInfo.subtype == 'hide') {
        const selected = figma.currentPage.selection;

        let sorted: SceneNode[] = [];
        for (const item of selected) {
            if (isShowHideNode(item))
                sorted.push(item);
        }

        const sortIndex = (a: SceneNode) => {
            return a.y + a.x
        };
        //the order of events is so that it progresses in the down-right direction

        sorted = sorted.sort((a, b) => sortIndex(a) - sortIndex(b));
        for (const item of sorted) {

            if (item.type === 'GROUP' && item.name.startsWith('Group')) {
                //improve the name
                item.name = goodName(item);
            }

            database.events.push({
                type: eventInfo.subtype,
                id: item.id,
                name: item.name,
                merged: false,
                children: []
            })
        }

    }
    if (eventInfo.subtype == 'child') {
        if (eventInfo.id == null) {
            const newSlide = createNewSlide(currentSlide.width, currentSlide.height);
            newSlide.name = eventInfo.name;
            eventInfo.id = newSlide.id;
        }
        createChildEvent(eventInfo.id);
    }
    saveCurrentData();
    sendEventList();
}

//remove an event from the current event list
function removeEvent(index: number): void {
    const event = database.events[index];
    if (event.type == "child") {
        const rect = findEventObject(event, currentSlide);
        if (rect != null)
            rect.remove();
    }
    database.events.splice(index, 1);
    saveCurrentData();
    sendEventList();
}

//merge or de-merge an event with the previous one 
function mergeEvent(index: number): void {
    const event = database.events[index];
    event.merged = !event.merged;
    saveCurrentData();
    sendEventList();
}


//change order of event list so that source becomes target. The source and target are counted among merged blocks of events
function reorderEvents(sourceBlock: number, targetBlock: number): void {

    //the source is a block, and so is the target
    const blockStarts: number[] = [];
    let i: number;
    for (i = 0; i < database.events.length; i++) {
        if (database.events[i].merged == false)
            blockStarts.push(i);
    }
    blockStarts.push(i);
    const source = blockStarts[sourceBlock];
    const target = blockStarts[targetBlock];
    const sourceCount = blockStarts[sourceBlock + 1] - source;
    const targetCount = blockStarts[targetBlock + 1] - target;

    let realTarget;
    if (source > target) {
        realTarget = target;
    } else {
        realTarget = target + targetCount - sourceCount;
    }

    const block = database.events.splice(source, sourceCount);
    while (block.length > 0) {
        database.events.splice(realTarget, 0, block.pop());
    }

    saveCurrentData();
    sendEventList();

}

//when the mouse hovers over an event, then it should be highlighted by figma, with a pretend selection
function hoverEvent(index: number): void {
    if (index == -1) {
        if (savedSelection != null) {
            figma.currentPage.selection = savedSelection;
        }
        savedSelection = null;
    } else {
        if (savedSelection == null)
            savedSelection = figma.currentPage.selection;

        const event = database.events[index];
        const link = findEventObject(event, currentSlide);
        if (link != null)
            figma.currentPage.selection = [link];
    }
}

//if the event on a plugin is clicked, then the corresponding object in figma should be selected
function clickEvent(index: number): void {
    const event = database.events[index];
    if (event.type == 'child') {
        gotoSlide(findSlide(event.id));
    } else
        savedSelection = figma.currentPage.selection;
}

//send the svg file to the ui, which then sends it to the server
function saveFile(): void {

    //the list of slides and their svg files
    const slideList: {
        database: Database,
        svg: Uint8Array
    } [] = [];
    //stack of the recursion, to find cycles in slides
    const stack: FrameNode[] = [];

    //Saves a single slide, and then calls itself for the children of that slide. The result of saving is a new item on slideList.
    async function saveRec(slide: FrameNode): Promise < SlideEvent > {
        let retval;
        if (stack.includes(slide)) {
            let cycle = "The slides contain a cycle: \n";
            for (const n of stack)
                cycle += (n.name + "\n");
            figma.notify(cycle + slide.name);
            return null;
        } else {
            stack.push(slide);
            currentSlide = slide;
            loadCurrentData();

            //We temporarily change the names of the children to their id's, so that the svg will have them as id's. (This is because Figma's svg export uses the object's name as the id for the svg. )
            //the function returns a list of pairs (node, old name) that can be used to revert these changes
            const changes: {
                node: SceneNode,
                savedName: string
            } [] = [];
            for (const event of database.events) {
                const node = findEventObject(event, slide);
                if (node != null) {
                    //we store the changes in reverse order,  so that the original names are at the end of the change list 
                    changes.unshift({ //unshift instead of push makes the order reversed
                        node: node,
                        savedName: node.name
                    });
                    node.name = event.id;
                }
            }

            const svg = await slide.exportAsync({
                format: 'SVG',
                svgOutlineText: true,
                svgIdAttribute: true
            });

            //we now undo the name changes. This needs to be done in reverse order to recover the original names
            for (const change of changes) {
                change.node.name = change.savedName;
            }

            retval = {
                type: 'child',
                name: database.name,
                id: database.id,
                merged: false,
                children: []
            }

            saveCurrentData();
            slideList.push({
                database: database,
                svg: svg
            });
            for (const event of database.events) {
                if (!event.disabled) {
                    if (event.type == "child") {
                        const child = await saveRec(findSlide(event.id));
                        child.merged = event.merged;
                        retval.children.push(child);

                    } else
                        retval.children.push(event);
                }

            }

            stack.pop();
            return retval;
        }
    }


    const savedSlide = currentSlide;
    saveRec(currentSlide).then(x => {
        figma.ui.postMessage({
            type: 'savePresentation',
            name: figma.root.name,
            slideList: slideList,
            tree: x
        });
        currentSlide = savedSlide;
        loadCurrentData();
    });

}


// save the plugin data, for the current slide, to the file
function saveCurrentData(): void {
    database.name = currentSlide.name;
    database.id = currentSlide.id;
    currentSlide.setPluginData("database", JSON.stringify(database));
}


// the opposite of the previous function
function loadCurrentData(): void {
    database = getDatabase(currentSlide);
    if (database == null) {
        //there is no database
        database = {
            name: currentSlide.name,
            id: currentSlide.id,
            events: []
        }
    }
    cleanDatabase();
}

//fix the database if it was created in a previous version, by possibly adding attributes
function fixVersion(database: Database) {
    for (const event of database.events) {
        if (event.merged == undefined) {
            event.merged = false;
        }
    }
}

//get the database for a slide
function getDatabase(slide: FrameNode) {
    const s = slide.getPluginData("database");
    if (s == '')
        return null
    else {
        const parsed = JSON.parse(s);
        fixVersion(parsed);
        return parsed;
    }
}


//says if the node is a possible target for a show/hide event
function isShowHideNode(node: SceneNode): boolean {
    if (node.parent != currentSlide || node.getPluginData('childLink') != '')
        return false;
    return true;
}

//a node is a slide if it is a frame and its parent is not a frame
function isSlideNode(node: BaseNode): boolean {
    if (node == null)
        return false;
    return (node.type == "COMPONENT" || node.type == 'FRAME') && (node.parent.type === "PAGE")
}

//return the list of all slides
function allSlides(): FrameNode[] {
    const retval = [] as FrameNode[];
    for (const node of (figma.currentPage.children)) {
        if (isSlideNode(node))
            retval.push(node as FrameNode)
    }
    return retval
}

//find a slide in the document with the given id
function findSlide(id: string): FrameNode {
    for (const node of allSlides())
        if (node.id == id)
            return node;
    return null;
}


//Gives the object in the slide that corresponds to the event. For a show/hide event this is the node that is shown/hidden. For a child event, this is the link to the child.
function findEventObject(event: SlideEvent, slide: FrameNode): SceneNode {
    if (event.type == 'show' || event.type == 'hide')
        for (const child of slide.children)
            if (event.id == child.id)
                return child as SceneNode;

    if (event.type == 'child') {
        //find the object in the current slide, which represents a link to a child slide. This object is indicated by plugin data. Currently, it is a semi-transparent red rectangle.
        const nodes = slide.findAll((node: SceneNode) => node.getPluginData("childLink") == event.id);
        if (nodes.length > 0)
            return nodes[0] as SceneNode
    }
    return null;
}


//for each event, check if it is active
// a child event is active if the linked frame exists
// a show/hide event is active if the linked object exists
// for the active show/hide events, store the index of the corresponding item
function cleanDatabase(): void {
    database.name = currentSlide.name;
    for (const event of database.events) {
        event.disabled = true;
        const node = findEventObject(event, currentSlide);
        if (node != null) {
            if (event.type == "child") {
                const f = findSlide(event.id);
                if (f != null) {
                    event.name = f.name;
                    node.name = f.name;
                    event.disabled = false;
                }
            }
            if (event.type == "show" || event.type == "hide") {
                event.name = node.name;
                event.disabled = false;
            }
        }
    }
}


//return any slide that points to slide as a child
function parentSlide(slide: FrameNode): FrameNode {
    for (const other of allSlides()) {
        const db = getDatabase(other);
        if (db != null)
            for (const event of db.events)
                if (event.type == 'child' && event.id == slide.id)
                    return other;
    }
    return null;
}

//set the current slide of the plugin
function setCurrentSlide(slide: FrameNode): void {
    currentSlide = slide;


    if (slide != null) {
        loadCurrentData();
        const msg = {
            type: 'slideChange',
            docName: figma.root.name,
            slide: currentSlide.name,
            parent: undefined as string,
            // slideId: currentSlide.id,
            slideCount: allSlides().length,
        }
        /*
        //this code runs too long and creates trouble
        const parent = parentSlide(slide);
        if (parent == null)
            msg.parent = null
        else
            msg.parent = parent.name;
        */

        figma.ui.postMessage(msg);
        sendEventList();
    } else {
        figma.ui.postMessage({
            type: 'noSlide'
        })
    }
}

//go to a slide and show it on the screen
function gotoSlide(slide: FrameNode): void {
    figma.viewport.scrollAndZoomIntoView([slide]);
    setCurrentSlide(slide);
}


//returns the slide with the currently selected object
function slideWithSelection(): FrameNode {
    const sel = figma.currentPage.selection;
    if (sel.length > 0) {
        let node = sel[0];
        while (!isSlideNode(node) && node != null)
            node = node.parent as SceneNode;
        return node as FrameNode;
    } else
        return null;
}


//the selection has changed
function selChange(): void {

    //if there is a saved selection, this means that the change was triggered by the user hovering over the event list in the plugin, and hence it should not count
    if (savedSelection == null) {
        const slide = slideWithSelection();

        const msg = {
            type: 'selChange',
            selected: false, // is there at least one object that can be used for show/hide
            latexState: LatexState.None, // is the current selection an object that can be latexed/de-latexed
            canInsert: false, // is the caret in a text field where characters can be inserted
            currentFont: null as FontName
        };

        for (const item of figma.currentPage.selection) {
            if (isShowHideNode(item))
                msg.selected = true;
        }

        // this part of the code is for the math features of latexit and inserting characters
        const sel = figma.currentPage.selection;
        if (sel.length == 1) {
            if (sel[0].type == "TEXT") //the selected object can be latexed
                msg.latexState = LatexState.Latex;
            if (matematykData(sel[0]) != null) //the selected object can be de-latexed
                msg.latexState = LatexState.Delatex
        }
        if (figma.currentPage.selectedTextRange != null) {
            const r = figma.currentPage.selectedTextRange.end;
            if (r > 0) {
                msg.currentFont = (sel[0] as TextNode).getRangeFontName(r - 1, r) as FontName
            }
            msg.canInsert = true;
        }


        //send the information about the updated selection
        figma.ui.postMessage(msg)


        //we change the current slide if it has been removed, or the selection has moved to some other non-null slide (the selection is in a null slide if it is outside all slides) 
        if ((currentSlide != null && currentSlide.removed) || (slide != currentSlide && slide != null))
            setCurrentSlide(slide);
        else if (currentSlide != null)
            sendEventList();

    }
}


//handle messages that come from the ui
function onMessage(msg: MessageToCode) {

    switch (msg.type) {

        case 'notify':
            //write a user notification
            figma.notify(msg.text);
            break

        case 'createEvent':
            //create a new event for the current slide
            //this covers show/hide/child events
            createEvent(msg);
            break;

        case 'settings':
            //get settings from the interface
            getSettings(msg.pluginSettings);
            break;

        case 'removeEvent':
            //remove an event
            removeEvent(msg.index);
            break;

        case 'mergeEvent':
            //merge an event with the previous one
            mergeEvent(msg.index);
            break;

        case 'moveEvent':
            //swap the order of two events
            reorderEvents(msg.index, msg.target);
            break;

        case 'makeFirst':
            //make a first slide
            setCurrentSlide(createNewSlide(msg.width, msg.height));
            figma.viewport.scrollAndZoomIntoView([currentSlide]);
            break;

        case 'saveFile':
            //export the files to svg files
            saveFile();
            break;

        case 'mouseEnterPlugin':
            //I'm not sure if this is necessary, but just in case I refresh the event list when the mouse enters the plugin.
            if (currentSlide != null)
                sendEventList();
            break;

        case 'hoverEvent':
            //highlight an event when the mouse hovers over it. For show/hide event we change the selection to the concerned object, for child events we do this for the link.
            hoverEvent(msg.index);
            break;

        case 'requestDropDown':
            //request a list of all slides for the current slide
            sendDropDownList();
            break;

        case 'mouseLeave':
            //unselect the action from the previous event
            figma.currentPage.selection = savedSelection;
            break;

        case 'clickEvent':
            //if an event is clicked, then the selection stays permanent
            clickEvent(msg.index)
            break;

        case 'gotoParent':
            //the parent button is clicked
            gotoSlide(parentSlide(currentSlide));
            break;

        case 'addWord':
            //functions for the matematyk plugin ******
            matematykWord(msg.text);
            break;

        case 'latexit':
            //the user requests turning text into latex
            latexitOne();
            break;

        case 'latexitTwo':
            //the second stage of latexit, is necessary because only the ui can communicate with the web
            latexitTwo(msg.text);
            break;


        default:
            throw "uncovered message type sent to code: "

    }






}


figma.on("selectionchange", selChange);
figma.showUI(__html__, {
    width: 230,
    height: 500
});
figma.ui.onmessage = onMessage;


setCurrentSlide(slideWithSelection());
initPlugin();
// repairOldFormat();