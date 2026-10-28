Generate competing root-cause hypotheses for this incident: {{ incident }}

{% include "_fragments/Facts.md" +%}

Produce three to five hypotheses with genuinely different mechanisms, not one story in five
phrasings. At least one should involve the quiet domains (config or dependencies), and at least one
should challenge the obvious suspect. Give each an id (H1, H2, ...), the causal story, the mechanism
and two to four predictions: specific, checkable facts that must hold if the hypothesis is true ("the
error rate started after SHA X", "the bad output only occurs for inputs over 1 MB"). The falsifiers
attack the predictions; a vague prediction makes a hypothesis untestable, which is a defect.
