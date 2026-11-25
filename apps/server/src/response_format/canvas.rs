//! Typed presentation plans and app-owned visual data. Coordinates, colors and actions
//! belong to the renderer; model-authored content remains attributed to Pi.
use super::{ComparisonMode, ResponseCard, filled};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use ts_rs::TS;

/// Semantic response category plus an optional app-owned composition tree.
/// Without composition, saved replies retain their legacy focus/support layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CanvasPlan {
    pub layout: CanvasLayout,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub headline: Option<String>,
    pub focus: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub composition: Option<CanvasNode>,
}

/// Ordered grouping only: the app owns breakpoints, spacing and safe block rendering.
/// Every block must appear exactly once. Existing details cards own disclosure;
/// groups cannot hide warnings, required actions or recorded failures.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum CanvasNode {
    Block { index: usize },
    Stack { children: Vec<CanvasNode> },
    Section { title: String, children: Vec<CanvasNode> },
    Columns { ratio: ColumnRatio, children: Vec<CanvasNode> },
    ComparisonPanels { mode: ComparisonMode, left: ComparisonPanel, right: ComparisonPanel },
}
/// One named side of a composed comparison. The nonempty block indices refer to the
/// reply's existing blocks in reading order; each index is used once in the entire canvas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComparisonPanel { pub title: String, pub blocks: Vec<usize> }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ColumnRatio { Equal, Leading }
impl CanvasNode {
    fn collect(&self, depth: usize, count: &mut usize, seen: &mut HashSet<usize>, blocks: usize) -> bool {
        *count += 1;
        if depth > 4 || *count > 64 { return false; }
        let children = match self {
            Self::Block { index } => return *index < blocks && seen.insert(*index),
            Self::ComparisonPanels { left, right, .. } => return [left, right].iter().all(|side| {
                filled(&side.title) && !side.blocks.is_empty() && side.blocks.iter().all(|&index|
                    Self::Block { index }.collect(depth + 1, count, seen, blocks))
            }),
            Self::Section { title, children } if filled(title) => children,
            Self::Stack { children } => children,
            Self::Columns { children, .. } if children.len() == 2 => children,
            _ => return false,
        };
        !children.is_empty() && children.iter().all(|child| child.collect(depth + 1, count, seen, blocks))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CanvasLayout { Result, Explanation, Investigation, Review, Plan, Comparison, #[serde(other)] Answer }
impl CanvasPlan {
    pub(super) fn valid(&self, blocks: &[ResponseCard]) -> bool {
        self.focus.is_none_or(|index| {
            blocks.get(index).is_some_and(|block| !matches!(block, ResponseCard::Details { .. }))
        }) && self.composition.as_ref().is_none_or(|node| {
            let mut seen = HashSet::new();
            node.collect(0, &mut 0, &mut seen, blocks.len()) && seen.len() == blocks.len()
        })
    }
}

/// A labelled node with a semantic shape, rendered by the app's SVG diagram layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct DiagramNode { pub id: String, pub label: String, pub kind: DiagramNodeKind }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DiagramNodeKind { Input, Process, Store, Decision, Output }
/// A directed connection. Hypotheses use a dashed stroke and an explicit legend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct DiagramEdge { pub from: String, pub to: String, pub label: String, pub relation: DiagramRelation }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DiagramRelation { Direct, Hypothesis }

/// Source-reported decimal text. Keeping the original spelling preserves precision and units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChartValue { pub label: String, pub value: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TimelineItem { pub label: String, pub text: String, pub kind: TimelineKind }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TimelineKind { Reported, Hypothesis, Next }
/// One named entry point or phase; its steps retain reading/execution order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PathGroup { pub label: String, pub steps: Vec<PathStep> }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PathStep {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub annotation: Option<PathAnnotation>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PathAnnotation { pub kind: AnnotationKind, pub text: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationKind { Context, Cost, Risk }
impl PathGroup {
    pub(super) fn valid(&self) -> bool {
        filled(&self.label) && !self.steps.is_empty() && self.steps.iter().all(|s| {
            filled(&s.text) && s.annotation.as_ref().is_none_or(|a| filled(&a.text))
        })
    }
}

/// A Pi-authored assessment; severity conveys priority rather than independent verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ResponseFinding {
    pub severity: FindingSeverity,
    pub title: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub location: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity { Critical, High, Medium, Low }

pub(super) fn diagram_valid(nodes: &[DiagramNode], edges: &[DiagramEdge]) -> bool {
    let ids: HashSet<_> = nodes.iter().map(|node| node.id.as_str()).collect();
    !nodes.is_empty() && ids.len() == nodes.len()
        && nodes.iter().all(|node| filled(&node.label) && filled(&node.id)
            && node.id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')))
        && edges.iter().all(|edge| ids.contains(edge.from.as_str()) && ids.contains(edge.to.as_str()))
}
pub(super) fn chart_valid(unit: &str, items: &[ChartValue]) -> bool {
    filled(unit) && !items.is_empty() && items.iter().all(|item| {
        filled(&item.label) && filled(&item.value)
            && item.value.parse::<f64>().is_ok_and(f64::is_finite)
    })
}
pub(super) fn timeline_valid(items: &[TimelineItem]) -> bool {
    !items.is_empty() && items.iter().all(|item| filled(&item.label) && filled(&item.text))
}
/// Identifies the first violated findings constraint without copying model-authored text.
pub(super) fn findings_error(title: &str, items: &[ResponseFinding]) -> Option<&'static str> {
    if title.trim().is_empty() { return Some("Invalid findings: component title is empty"); }
    if items.is_empty() { return Some("Invalid findings: at least one finding is required"); }
    for item in items {
        if item.title.trim().is_empty() { return Some("Invalid findings: a finding title is empty"); }
        if item.text.trim().is_empty() { return Some("Invalid findings: a finding text is empty"); }
        if let Some(location) = &item.location {
            if location.trim().is_empty() { return Some("Invalid findings: a location is empty; omit location when unknown"); }
        }
    }
    None
}
