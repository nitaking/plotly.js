/**
* Copyright 2012-2019, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/

'use strict';

var d3 = require('d3');
var d3Hierarchy = require('d3-hierarchy');

var Fx = require('../../components/fx');
var Color = require('../../components/color');
var Drawing = require('../../components/drawing');
var Lib = require('../../lib');
var Events = require('../../lib/events');
var svgTextUtils = require('../../lib/svg_text_utils');
var setCursor = require('../../lib/setcursor');
var appendArrayPointValue = require('../../components/fx/helpers').appendArrayPointValue;

var transformInsideText = require('../pie/plot').transformInsideText;
var transformOutsideText = require('../pie/plot').transformOutsideText;
var scootLabels = require('../pie/plot').scootLabels;
var plotTextLines = require('../pie/plot').plotTextLines;
var formatPieValue = require('../pie/helpers').formatPieValue;
var styleOne = require('./style').styleOne;

var TRANSITION_TIME = 1500;

module.exports = function plot(gd, cdmodule) {
    var fullLayout = gd._fullLayout;
    var layer = fullLayout._sunburstlayer;
    var gs = fullLayout._size;

    // TODO add 'stroke-linejoin': 'round' or 'stroke-miterlimit' ???

    Lib.makeTraceGroups(layer, cdmodule, 'trace').each(function(cd) {
        var gTrace = d3.select(this);
        var cd0 = cd[0];
        var trace = cd0.trace;
        var hierarchy = cd0.hierarchy;
        var maxDepth = trace.maxdepth >= 0 ? trace.maxdepth : Infinity;

        var domain = trace.domain;
        var vpw = gs.w * (domain.x[1] - domain.x[0]);
        var vph = gs.h * (domain.y[1] - domain.y[0]);
        var rMax = 0.5 * Math.min(vpw, vph);
        var cx = cd0.cx = gs.l + gs.w * (domain.x[1] + domain.x[0]) / 2;
        var cy = cd0.cy = gs.t + gs.h * (1 - domain.y[0]) - vph / 2;

        function render(entry) {
            var slices = gTrace.selectAll('g.slice');

            if(!entry) {
                slices.remove();
                return;
            }

            var prevRootPt;

            slices.each(function(pt) {
                pt.data.data.prev = {
                    rpx0: pt.rpx0,
                    rpx1: pt.rpx1,
                    x0: pt.x0,
                    x1: pt.x1
                };
                if(!pt.parent) {
                    prevRootPt = pt;
                }
            });

            var sliceData = partition(entry)
                .descendants()
                .filter(function(pt) { return pt.y1 <= maxDepth; });

            var maxHeight = entry.height + 1;
            var yOffset = 0;

            if(cd0.hasMultipleRoots && sliceData[0].data.data.pid === '') {
                sliceData = sliceData.slice(1);
                maxHeight -= 1;
                yOffset = 1;
            }

            // TODO clean up variable names
            // -> differentiate between 'entry root' and 'hierarchy root'

            var rootPt = sliceData[0];
            var maxY = Math.min(maxHeight, maxDepth);
            var y2rpx = function(y) { return (y - yOffset) / maxY * rMax; };
            var rx2px = function(r, x) { return [r * Math.cos(x), -r * Math.sin(x)]; };
            var pathSlice = function(d) { return Lib.pathAnnulus(d.rpx0, d.rpx1, d.x0, d.x1, cx, cy); };
            var makeTweenFn = function(prev, next) {
                var interp = d3.interpolate(prev, next);
                return function(t) { return pathSlice(interp(t)); };
            };

            slices = slices.data(sliceData, function(pt) { return pt.data.data.id; });

            slices.enter().append('g').classed('slice', true);

            slices.exit().each(function(pt) {
                var sliceTop = d3.select(this).transition()
                    .duration(TRANSITION_TIME)
                    .each('end', function(pt2) {
                        pt2.data.data.prev = null;
                        d3.select(this).remove();
                    });

                var slicePath = sliceTop.select('path.surface');

                slicePath.attrTween('d', function(pt2) {
                    var rootPtPrev = rootPt.data.data.prev;
                    var a = pt2.x1 > rootPtPrev.x1 ? 2 * Math.PI : 0;
                    // if pt to remove:
                    // - is 'below' where the root-node used to be: shrink it radially
                    // - otherwise, collapse it clockwise or counterclockwise which ever is shortest to theta=0
                    var next = pt2.rpx1 < rootPtPrev.rpx1 ? {rpx0: 0, rpx1: 0} : {x0: a, x1: a};
                    return makeTweenFn(pt.data.data.prev, next);
                });

                var sliceTextGroup = sliceTop.select('g.slicetext');
                sliceTextGroup.attr('opacity', 0);

                // TODO text lines
            });

            var hasOutsideText = false;
            var quadrants = [
                [[], []], // y<0: x<0, x>=0
                [[], []]  // y>=0: x<0, x>=0
            ];

            var nextX1ofPrevRootPt = null;
            if(prevRootPt) {
                slices.each(function(pt) {
                    if(nextX1ofPrevRootPt === null && (pt.data.data.id === prevRootPt.data.data.id)) {
                        nextX1ofPrevRootPt = pt.x1;
                    }
                });
            }

            slices.each(function(pt) {
                var sliceTop = d3.select(this);
                var cdi = pt.data.data;
                var isRoot = cdi.pid === '';
                var isLeaf = !pt.children;

                var slicePath = Lib.ensureSingle(sliceTop, 'path', 'surface', function(s) {
                    s.style('pointer-events', 'all');
                });

                pt.next = {x0: pt.x0, x1: pt.x1};
                pt.rpx0 = pt.next.rpx0 = y2rpx(pt.y0);
                pt.rpx1 = pt.next.rpx1 = y2rpx(pt.y1);
                pt.xmid = (pt.x0 + pt.x1) / 2;
                pt.pxmid = rx2px(pt.rpx1, pt.xmid);
                pt.midangle = -(pt.xmid - Math.PI / 2);
                pt.halfangle = 0.5 * Math.min(Lib.angleDelta(pt.x0, pt.x1), Math.PI);
                pt.ring = 1 - (pt.rpx0 / pt.rpx1);
                pt.rInscribed = getInscribedRadiusFraction(pt, trace);
                quadrants[pt.pxmid[1] < 0 ? 0 : 1][pt.pxmid[0] < 0 ? 0 : 1].push(pt);

                slicePath.transition()
                    .duration(TRANSITION_TIME)
                    .attrTween('d', function(pt2) {
                        var prev0 = pt2.data.data.prev;
                        var prev;

                        if(prev0) {
                            // if pt already on graph, this is easy
                            prev = prev0;
                        } else {
                            // for new pts:
                            if(prevRootPt) {
                                // if trace was visible before
                                if(pt2.parent) {
                                    // if new branch, twist it in clockwise or
                                    // counterclockwise which ever is shorter to
                                    // its final angle
                                    var a = pt2.x1 > nextX1ofPrevRootPt ? 2 * Math.PI : 0;
                                    prev = {x0: a, x1: a};
                                } else {
                                    // if new root-node, grow it radially
                                    prev = {rpx0: 0, rpx1: 0};
                                }
                            } else {
                                // start sector of new traces from theta=0
                                prev = {x0: 0, x1: 0};
                            }
                        }

                        return makeTweenFn(prev, pt2.next);
                    });

                slicePath.call(styleOne, pt, trace);
                sliceTop.call(attachHoverHandlers, gd, cd);

                if(!isLeaf && !isRoot) {
                    sliceTop
                        .call(setCursor, 'pointer')
                        .call(attachClickHandlers, gd, cd, render);
                }
                // else { TODO attach leaf/root click handlers? }

                var sliceTextGroup = Lib.ensureSingle(sliceTop, 'g', 'slicetext');
                var sliceText = Lib.ensureSingle(sliceTextGroup, 'text', '', function(s) {
                    // prohibit tex interpretation until we can handle
                    // tex and regular text together
                    s.attr('data-notex', 1);
                });

                sliceText
                    .attr('opacity', 0)
                    .transition().duration(TRANSITION_TIME)
                    .attr('opacity', 1);

                var textPosition = isLeaf ? trace.leaf.textposition : 'inside';

                sliceText
                    .text(formatSliceLabel(pt, trace, fullLayout))
                    .attr({
                        'class': 'slicetext',
                        transform: '',
                        'text-anchor': 'middle'
                    })
                    .call(Drawing.font, isRoot || textPosition === 'outside' ?
                      determineOutsideTextFont(trace, pt, gd._fullLayout.font) :
                      determineInsideTextFont(trace, pt, gd._fullLayout.font))
                    .call(svgTextUtils.convertToTspans, gd);

                // position the text relative to the slice
                var textBB = Drawing.bBox(sliceText.node());
                var transform;

                if(textPosition === 'outside') {
                    transform = transformOutsideText(textBB, pt);
                } else {
                    transform = transformInsideText(textBB, pt, cd0);
                    if(textPosition === 'auto' && transform.scale < 1) {
                        sliceText.call(Drawing.font, trace.outsidetextfont);
                        if(trace.outsidetextfont.family !== trace.insidetextfont.family ||
                                trace.outsidetextfont.size !== trace.insidetextfont.size) {
                            textBB = Drawing.bBox(sliceText.node());
                        }
                        transform = transformOutsideText(textBB, pt);
                    }
                }

                var translateX = cx + pt.pxmid[0] * transform.rCenter + (transform.x || 0);
                var translateY = cy + pt.pxmid[1] * transform.rCenter + (transform.y || 0);

                // save some stuff to use later ensure no labels overlap
                if(transform.outside) {
                    pt.px0 = rx2px(pt.rpx0, pt.x0);
                    pt.px1 = rx2px(pt.rpx1, pt.x1);
                    pt.cxFinal = cx;
                    pt.cyFinal = cy;
                    pt.yLabelMin = translateY - textBB.height / 2;
                    pt.yLabelMid = translateY;
                    pt.yLabelMax = translateY + textBB.height / 2;
                    pt.labelExtraX = 0;
                    pt.labelExtraY = 0;
                    hasOutsideText = true;
                }

                sliceText.attr('transform',
                    'translate(' + translateX + ',' + translateY + ')' +
                    (transform.scale < 1 ? ('scale(' + transform.scale + ')') : '') +
                    (transform.rotate ? ('rotate(' + transform.rotate + ')') : '') +
                    'translate(' +
                        (-(textBB.left + textBB.right) / 2) + ',' +
                        (-(textBB.top + textBB.bottom) / 2) +
                    ')');
            });

            if(hasOutsideText) {
                scootLabels(quadrants, trace);
            }

            // TODO fade in/out
            plotTextLines(slices, trace);
        }

        render(findEntryWithLevel(hierarchy, trace.level));
    });
};

// x[0-1] keys are angles [radians]
// y[0-1] keys are hierarchy heights [integers]
function partition(entry) {
    return d3Hierarchy.partition()
        .size([2 * Math.PI, entry.height + 1])(entry);
}

function findEntryWithLevel(hierarchy, level) {
    var out;
    if(level) {
        hierarchy.eachAfter(function(d) {
            if(!out && d.data.data.id === level) {
                out = d.copy();
            }
        });
    }
    return out || hierarchy;
}

function findEntryWithChild(hierarchy, childId) {
    var out;
    hierarchy.eachAfter(function(d) {
        if(!out) {
            var children = d.children || [];
            for(var i = 0; i < children.length; i++) {
                var child = children[i];
                if(child.data.data.id === childId) {
                    out = d.copy();
                }
            }
        }
    });
    return out || hierarchy;
}

function attachHoverHandlers(sliceTop, gd, cd) {
    var cd0 = cd[0];
    var trace = cd0.trace;

    // hover state vars
    // have we drawn a hover label, so it should be cleared later
    var hasHoverLabel = false;
    // have we emitted a hover event, so later an unhover event should be emitted
    // note that click events do not depend on this - you can still get them
    // with hovermode: false or if you were earlier dragging, then clicked
    // in the same slice that you moused up in
    var hasHoverEvent = false;

    sliceTop.on('mouseover', function(pt) {
        var fullLayoutNow = gd._fullLayout;

        if(gd._dragging || fullLayoutNow.hovermode === false) return;

        var traceNow = gd._fullData[trace.index];
        var cdi = pt.data.data;
        var ptNumber = cdi.i;

        var _cast = function(astr) {
            return Lib.castOption(traceNow, ptNumber, astr);
        };

        var hovertemplate = _cast('hovertemplate');
        var hoverinfo = Fx.castHoverinfo(traceNow, fullLayoutNow, ptNumber);
        var separators = fullLayoutNow.separators;

        if(hovertemplate || (hoverinfo && hoverinfo !== 'none' && hoverinfo !== 'skip')) {
            var rInscribed = pt.rInscribed;
            var hoverCenterX = cd0.cx + pt.pxmid[0] * (1 - rInscribed);
            var hoverCenterY = cd0.cy + pt.pxmid[1] * (1 - rInscribed);
            var hoverPt = {};
            var parts = [];
            var thisText = [];
            var hasFlag = function(flag) { return parts.indexOf(flag) !== -1; };

            if(hoverinfo) {
                parts = hoverinfo === 'all' ?
                    traceNow._module.attributes.hoverinfo.flags :
                    hoverinfo.split('+');
            }

            hoverPt.label = cdi.label;
            if(hasFlag('label') && hoverPt.label) thisText.push(hoverPt.label);

            if(cdi.hasOwnProperty('v')) {
                hoverPt.value = cdi.v;
                hoverPt.valueLabel = formatPieValue(hoverPt.value, separators);
                if(hasFlag('value')) thisText.push(hoverPt.valueLabel);
            }

            hoverPt.text = _cast('hovertext') || _cast('text');
            if(hasFlag('text') && hoverPt.text) thisText.push(hoverPt.text);

            Fx.loneHover({
                x0: hoverCenterX - rInscribed * pt.rpx1,
                x1: hoverCenterX + rInscribed * pt.rpx1,
                y: hoverCenterY,
                idealAlign: pt.pxmid[0] < 0 ? 'left' : 'right',
                trace: traceNow,
                text: thisText.join('<br>'),
                name: (hovertemplate || hasFlag('name')) ? traceNow.name : undefined,
                color: _cast('hoverlabel.bgcolor') || cdi.color,
                borderColor: _cast('hoverlabel.bordercolor'),
                fontFamily: _cast('hoverlabel.font.family'),
                fontSize: _cast('hoverlabel.font.size'),
                fontColor: _cast('hoverlabel.font.color'),
                hovertemplate: hovertemplate,
                hovertemplateLabels: hoverPt,
                eventData: [makeEventData(pt, traceNow)]
            }, {
                container: fullLayoutNow._hoverlayer.node(),
                outerContainer: fullLayoutNow._paper.node(),
                gd: gd
            });

            hasHoverLabel = true;
        }

        gd.emit('plotly_hover', {
            points: [makeEventData(pt, traceNow)],
            event: d3.event
        });
        hasHoverEvent = true;
    });

    sliceTop.on('mouseout', function(evt) {
        var fullLayoutNow = gd._fullLayout;
        var traceNow = gd._fullData[trace.index];
        var pt = d3.select(this).datum();

        if(hasHoverEvent) {
            evt.originalEvent = d3.event;
            gd.emit('plotly_unhover', {
                points: [makeEventData(pt, traceNow)],
                event: d3.event
            });
            hasHoverEvent = false;
        }

        if(hasHoverLabel) {
            Fx.loneUnhover(fullLayoutNow._hoverlayer.node());
            hasHoverLabel = false;
        }
    });
}

// TODO or call restyle (or animate), but would that smoothly transition?
function attachClickHandlers(sliceTop, gd, cd, render) {
    var cd0 = cd[0];
    var trace = cd0.trace;

    sliceTop.on('click', function(pt) {
        var traceNow = gd._fullData[trace.index];
        var clickVal = Events.triggerHandler(gd, 'plotly_sunburstclick', {
            points: [makeEventData(pt, traceNow)],
            event: d3.event
        });
        if(clickVal === false) return;

        var fullLayoutNow = gd._fullLayout;
        if(gd._dragging) return;

        // TODO skip during animations!

        Fx.loneUnhover(fullLayoutNow._hoverlayer.node());
        // Lib.raiseToTop(this);

        var hierarchy = cd0.hierarchy;
        var cdi = pt.data.data;
        var id = cdi.id;

        var entry = pt.parent ?
            findEntryWithLevel(hierarchy, id) :
            findEntryWithChild(hierarchy, id);

        var level = entry.descendants()[0].data.data.id;
        trace.level = trace._input.level = level;

        render(entry);

        // TODO event data
        // TODO should we trigger 'plotly_click' also?
    });
}

function makeEventData(pt, trace) {
    var cdi = pt.data.data;

    var out = {
        curveNumber: trace.index,
        pointNumber: cdi.i,
        data: trace._input,
        fullData: trace,

        // TODO more things like 'children', 'siblings', 'hierarchy?
    };

    appendArrayPointValue(out, trace, cdi.i);

    return out;
}

function formatSliceLabel(pt, trace, fullLayout) {
    var textinfo = trace.textinfo;

    if(!textinfo || textinfo === 'none') {
        return '';
    }

    var cdi = pt.data.data;
    var separators = fullLayout.separators;
    var parts = textinfo.split('+');
    var hasFlag = function(flag) { return parts.indexOf(flag) !== -1; };
    var thisText = [];

    if(hasFlag('label') && cdi.label) thisText.push(cdi.label);

    if(cdi.hasOwnProperty('v') && hasFlag('value')) {
        thisText.push(formatPieValue(cdi.v, separators));
    }

    if(hasFlag('text')) {
        var tx = Lib.castOption(trace, cdi.i, 'text');
        if(tx) thisText.push(tx);
    }

    return thisText.join('<br>');
}

function determineOutsideTextFont(trace, pt, layoutFont) {
    var ptNumber = pt.data.data.i;

    var color = Lib.castOption(trace, ptNumber, 'outsidetextfont.color') ||
        Lib.castOption(trace, ptNumber, 'textfont.color') ||
        layoutFont.color;

    var family = Lib.castOption(trace, ptNumber, 'outsidetextfont.family') ||
        Lib.castOption(trace, ptNumber, 'textfont.family') ||
        layoutFont.family;

    var size = Lib.castOption(trace, ptNumber, 'outsidetextfont.size') ||
        Lib.castOption(trace, ptNumber, 'textfont.size') ||
        layoutFont.size;

    return {
        color: color,
        family: family,
        size: size
    };
}

function determineInsideTextFont(trace, pt, layoutFont) {
    var ptNumber = pt.data.data.i;

    var customColor = Lib.castOption(trace, ptNumber, 'insidetextfont.color');
    if(!customColor && trace._input.textfont) {

        // Why not simply using trace.textfont? Because if not set, it
        // defaults to layout.font which has a default color. But if
        // textfont.color and insidetextfont.color don't supply a value,
        // a contrasting color shall be used.
        customColor = Lib.castOption(trace._input, ptNumber, 'textfont.color');
    }

    var family = Lib.castOption(trace, ptNumber, 'insidetextfont.family') ||
        Lib.castOption(trace, ptNumber, 'textfont.family') ||
        layoutFont.family;

    var size = Lib.castOption(trace, ptNumber, 'insidetextfont.size') ||
        Lib.castOption(trace, ptNumber, 'textfont.size') ||
        layoutFont.size;

    return {
        color: customColor || Color.contrast(pt.color),
        family: family,
        size: size
    };
}

function getInscribedRadiusFraction(pt) {
    if(pt.rpx0 === 0 && pt.xmid === Math.PI) {
        // special case of 100% with no hole
        return 1;
    } else {
        return Math.max(0, Math.min(
            1 / (1 + 1 / Math.sin(pt.halfangle)),
            pt.ring / 2
        ));
    }
}
