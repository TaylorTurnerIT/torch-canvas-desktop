import torch
import torch.nn as nn
import torch.nn.functional as F

class Block19(nn.Module):
    def __init__(self, width=512, h1=256, hidden=1024, dropout=0.1):
        super().__init__()
        self.input_norm = nn.LayerNorm(width)
        self.value_up = nn.Linear(width, hidden)
        self.value_norm = nn.LayerNorm(hidden)
        self.gate_up = nn.Linear(width, hidden)
        self.gate_norm = nn.LayerNorm(hidden)
        self.down = nn.Linear(hidden, width)
        self.dropout = nn.Dropout(p=dropout)

    def forward(self, x):
        normalized = self.input_norm(x)
        h = self.value_up(normalized)
        value = self.value_norm(h)
        a = F.gelu(self.gate_up(normalized))
        gate = self.gate_norm(a)
        gated = value * gate
        return self.dropout(self.down(gated))

class ResidualMLP(nn.Module):
    # torch-canvas input x: e, 3, 32, 32
    # torch-canvas sizes: in_features=3072, num_classes=10
    """Baseline residual MLP.

    input -> Linear(in_features -> width)            project into the backbone
          -> depth x Block                           residual backbone, stays `width` wide
          -> LayerNorm -> Linear -> GELU -> Linear   head: a block without the skip
          -> logits (num_classes)

    The head has no skip connection because its output size (num_classes)
    differs from its input size (width), so the two cannot be added.
    """

    def __init__(self, in_features, num_classes, width=512, depth=6, h1=256, h3=256, hidden1=512, dropout=0.1):
        super().__init__()

        # Project the flattened image down to the backbone width.
        self.input_layer = nn.Linear(in_features, width)
        self.blocks = nn.ModuleList([Block19(width, hidden1, dropout=dropout) for _ in range(6)])
        self.head_fc2 = nn.Linear(width, num_classes)

        # Xavier (Glorot) initialization for every linear layer, zero biases.
        for layer in self.modules():
            if isinstance(layer, nn.Linear):
                nn.init.xavier_normal_(layer.weight)
                nn.init.zeros_(layer.bias)

    def forward(self, x):
        """Training forward pass. Returns raw logits (no softmax).

        nn.CrossEntropyLoss applies the softmax itself, so training uses logits.
        """
        x = x.flatten(1)
        x = self.input_layer(x)
        for blk in self.blocks:
            x = blk(x)
        return self.head_fc2(x)

    def predict(self, x):
        """Inference pass, never used during training. Returns class probabilities."""
        self.eval()                           # switch layers to inference behavior
        with torch.no_grad():                 # no gradients needed at inference
            return torch.softmax(self.forward(x), dim=1)
